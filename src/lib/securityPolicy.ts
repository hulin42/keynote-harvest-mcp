import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harvestRoot, isPathWithin, realpathNearestExistingAncestor, workingRoot } from './paths.js';

const DEFAULT_MAX_INPUT_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_POPPLER_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_COMMAND_KILL_GRACE_MS = 5000;

function enabled(name: string) {
  const value = process.env[name];
  return value === '1' || value?.toLowerCase() === 'true';
}

function positiveIntegerSetting(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function localDebugAllowed() {
  return enabled('KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG');
}

export function assertLocalDebugAllowed(mode: string | undefined) {
  if (mode !== 'local-debug') return;
  if (!localDebugAllowed()) {
    throw new Error(
      'Local-debug path disclosure requires operator authorization. Set KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG=1 in the MCP server environment.'
    );
  }
}

export function sourceResourceAccessAllowed() {
  return enabled('KEYNOTE_HARVEST_ALLOW_SOURCE_RESOURCES');
}

export function allowedInputRoots() {
  const configured = (process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(workingRoot(), entry));

  return [...new Set([workingRoot(), harvestRoot(), ...configured])];
}

export function assertInputPathAllowed(filePath: string, label: string) {
  const resolvedPath = path.resolve(filePath);
  const resolvedRealPath = realpathNearestExistingAncestor(resolvedPath);
  const allowed = allowedInputRoots().some((root) => {
    const resolvedRoot = path.resolve(root);
    const realRoot = realpathNearestExistingAncestor(resolvedRoot);
    return isPathWithin(resolvedRoot, resolvedPath) && isPathWithin(realRoot, resolvedRealPath);
  });

  if (!allowed) {
    throw new Error(
      `${label} "${path.basename(resolvedPath)}" is outside the operator-configured input roots. Add its parent directory to KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS.`
    );
  }

  return resolvedPath;
}

export function allowedKeynoteAppRoots() {
  const configured = (process.env.KEYNOTE_HARVEST_ALLOWED_KEYNOTE_APP_ROOTS ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(workingRoot(), entry));

  return [...new Set(['/Applications', ...configured])];
}

export function isKeynoteAppPathAllowed(appPath: string) {
  const resolvedPath = path.resolve(appPath);
  const resolvedRealPath = realpathNearestExistingAncestor(resolvedPath);
  return allowedKeynoteAppRoots().some((root) => {
    const resolvedRoot = path.resolve(root);
    const realRoot = realpathNearestExistingAncestor(resolvedRoot);
    return isPathWithin(resolvedRoot, resolvedPath) && isPathWithin(realRoot, resolvedRealPath);
  });
}

export function assertKeynoteAppPathAllowed(appPath: string) {
  if (!isKeynoteAppPathAllowed(appPath)) {
    throw new Error(
      `Selected Keynote app "${path.basename(appPath)}" is outside the operator-configured application roots. Add its parent directory to KEYNOTE_HARVEST_ALLOWED_KEYNOTE_APP_ROOTS.`
    );
  }
  return appPath;
}

export function maxInputBytes() {
  return positiveIntegerSetting('KEYNOTE_HARVEST_MAX_INPUT_BYTES', DEFAULT_MAX_INPUT_BYTES);
}

export function assertInputFileSize(filePath: string, label: string) {
  if (!existsSync(filePath)) return;
  const fileInfo = statSync(filePath);
  if (!fileInfo.isFile()) return;
  const limit = maxInputBytes();
  if (fileInfo.size > limit) {
    throw new Error(`${label} "${path.basename(filePath)}" is ${fileInfo.size} bytes, over the ${limit}-byte input limit.`);
  }
}

export function maxOutputBytes() {
  return positiveIntegerSetting('KEYNOTE_HARVEST_MAX_OUTPUT_BYTES', DEFAULT_MAX_OUTPUT_BYTES);
}

export function popplerTimeoutMs() {
  return positiveIntegerSetting('KEYNOTE_HARVEST_POPPLER_TIMEOUT_MS', DEFAULT_POPPLER_TIMEOUT_MS);
}

export function maxCommandOutputBytes() {
  return positiveIntegerSetting('KEYNOTE_HARVEST_MAX_COMMAND_OUTPUT_BYTES', DEFAULT_MAX_COMMAND_OUTPUT_BYTES);
}

export function commandKillGraceMs() {
  return positiveIntegerSetting('KEYNOTE_HARVEST_COMMAND_KILL_GRACE_MS', DEFAULT_COMMAND_KILL_GRACE_MS);
}

const PASSTHROUGH_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  '__CF_USER_TEXT_ENCODING',
  'XPC_FLAGS',
  'XPC_SERVICE_NAME',
];

export function subprocessEnvironment() {
  const result = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of PASSTHROUGH_ENV_KEYS) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('KEYNOTE_') && value !== undefined) result[key] = value;
  }
  return result;
}

export function redactDisplayText(value: string, sensitivePaths: Array<string | undefined> = []) {
  let result = value;
  const knownPaths = [os.homedir(), ...sensitivePaths]
    .filter((entry): entry is string => Boolean(entry))
    .sort((left, right) => right.length - left.length);
  for (const sensitivePath of knownPaths) {
    const replacement = sensitivePath === os.homedir() ? '~' : path.basename(sensitivePath);
    result = result.replaceAll(sensitivePath, replacement);
  }
  return result
    .replace(/\/Users\/[^/\s]+/g, '/Users/[redacted]')
    .replace(/\/home\/[^/\s]+/g, '/home/[redacted]')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, 'C:\\Users\\[redacted]');
}
