import { spawn } from 'node:child_process';
import path from 'node:path';
import { workingRoot } from './paths.js';
import {
  commandKillGraceMs,
  maxCommandOutputBytes,
  subprocessEnvironment,
} from './securityPolicy.js';
import { augmentedToolPath } from './toolPath.js';

export type CommandResult = {
  stdout: string;
  stderr: string;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class CommandExecutionError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
  readonly timedOut: boolean;

  constructor(args: {
    message: string;
    stdout: string;
    stderr: string;
    exitCode?: number;
    timedOut?: boolean;
  }) {
    super(args.message);
    this.name = 'CommandExecutionError';
    this.stdout = args.stdout;
    this.stderr = args.stderr;
    this.exitCode = args.exitCode;
    this.timedOut = args.timedOut ?? false;
  }
}

export function commandTimeoutMs() {
  const configured = Number(process.env.KEYNOTE_HARVEST_COMMAND_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

export function runCommand(
  command: string,
  args: string[],
  options?: { timeoutMs?: number; onStderrLine?: (line: string) => void }
) {
  const timeoutMs = options?.timeoutMs ?? commandTimeoutMs();
  const onStderrLine = options?.onStderrLine;
  return new Promise<CommandResult>((resolve, reject) => {
    const commandName = path.basename(command);
    const detached = process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd: workingRoot(),
      env: { ...subprocessEnvironment(), PATH: augmentedToolPath() },
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputExceeded = false;
    let escalation: NodeJS.Timeout | undefined;
    const terminate = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (detached) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process may have exited between the state check and the signal.
      }
    };
    const scheduleEscalation = () => {
      if (escalation) return;
      escalation = setTimeout(() => terminate('SIGKILL'), commandKillGraceMs());
      escalation.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      scheduleEscalation();
    }, timeoutMs);
    timeout.unref();

    const appendOutput = (current: string, chunk: string) => {
      const next = current + chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > maxCommandOutputBytes()) {
        outputExceeded = true;
        terminate('SIGTERM');
        scheduleEscalation();
        return current;
      }
      return next;
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = appendOutput(stdout, chunk);
    });
    // Progress lines are short; anything larger than this is not a progress
    // record and must not accumulate while the child drains after a limit
    // trip or streams an unbounded single line.
    const MAX_STDERR_LINE_BUFFER_BYTES = 8192;
    let stderrLineBuffer = '';
    let discardingOversizedLine = false;
    child.stderr.on('data', (chunk) => {
      stderr = appendOutput(stderr, chunk);
      if (!onStderrLine || outputExceeded) {
        stderrLineBuffer = '';
        return;
      }
      stderrLineBuffer += chunk;
      let newlineIndex = stderrLineBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stderrLineBuffer.slice(0, newlineIndex);
        stderrLineBuffer = stderrLineBuffer.slice(newlineIndex + 1);
        const skip = discardingOversizedLine || line.length > MAX_STDERR_LINE_BUFFER_BYTES;
        discardingOversizedLine = false;
        if (!skip) {
          try {
            onStderrLine(line);
          } catch {
            // Progress reporting must never break command execution.
          }
        }
        newlineIndex = stderrLineBuffer.indexOf('\n');
      }
      if (stderrLineBuffer.length > MAX_STDERR_LINE_BUFFER_BYTES) {
        stderrLineBuffer = '';
        discardingOversizedLine = true;
      }
    });
    child.on('error', () => {
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      reject(new CommandExecutionError({
        message: `Command "${commandName}" could not be started.`,
        stdout,
        stderr,
      }));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      if (outputExceeded) {
        reject(new CommandExecutionError({
          message: `Command "${commandName}" exceeded the command-output limit.`,
          stdout,
          stderr,
          exitCode: code ?? undefined,
        }));
        return;
      }
      if (timedOut) {
        reject(new CommandExecutionError({
          message: `Command "${commandName}" timed out after ${timeoutMs}ms.`,
          stdout,
          stderr,
          exitCode: code ?? undefined,
          timedOut: true,
        }));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new CommandExecutionError({
        message: `Command "${commandName}" failed with exit ${code}.`,
        stdout,
        stderr,
        exitCode: code ?? undefined,
      }));
    });
  });
}
