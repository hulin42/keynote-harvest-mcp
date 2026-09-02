import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { replaceManagedOutputs, siblingTemporaryPath, writeFileAtomically } from '../lib/atomicFiles.js';
import { updateJobRecord } from '../lib/jobs.js';
import { isKeynoteBundleTrusted } from '../lib/keynoteApps.js';
import { buildKeynoteExportScript } from '../lib/keynoteExportScript.js';
import { hasPdfStructure } from '../lib/pdfValidity.js';
import {
  assertKeynoteAppPathAllowed,
  isKeynoteAppPathAllowed,
  subprocessEnvironment,
} from '../lib/securityPolicy.js';
import { commandTimeoutMs } from '../lib/runCommand.js';
import { installStagingCleanup } from '../lib/stagingCleanup.js';
import { applyAugmentedToolPath } from '../lib/toolPath.js';

type ExportStatus = 'completed' | 'completed-with-warning' | 'failed';

type Args = {
  keynote: string;
  out: string;
  summary?: string;
  keynoteApp?: string;
  includeSourcePath: boolean;
  jobFile?: string;
};

type KeynoteAppCandidate = {
  name: string;
  path: string;
  bundleId?: string;
  version?: string;
  modifiedAt?: string;
  exists: boolean;
  allowed: boolean;
  selected?: boolean;
  recommended?: boolean;
};

type KeynoteAppSelection = {
  appPath: string;
  appName: string;
  bundleId?: string;
  version?: string;
  selectionSource: 'cli' | 'env' | 'discovered' | 'fallback';
  warnings: string[];
  candidates: KeynoteAppCandidate[];
};

type ExportSummary = {
  sourceType: 'keynote';
  sourceFileName: string;
  sourceDisplayName: string;
  sourcePath?: string;
  exportedPdfPath: string;
  exportTimestamp: string;
  exportStatus: ExportStatus;
  warnings: string[];
  pdfExists: boolean;
  pdfSizeBytes?: number;
  pdfModifiedAt?: string;
  pdfPageCount?: number;
  timedOut: boolean;
  message: string;
  tool: {
    name: string;
    keynoteAppPath: string;
    keynoteAppName?: string;
    keynoteAppVersion?: string;
    keynoteAppBundleId?: string;
    appSelectionSource: 'cli' | 'env' | 'discovered' | 'fallback';
    appSelectionWarnings: string[];
    timeoutMs: number;
  };
};

function usage(): never {
  throw new Error(
    'Usage: node --experimental-strip-types scripts/export-keynote-to-pdf.ts --keynote "/path/to/deck.key" --out ".harvests/deck/source/deck.pdf" [--keynote-app "/Applications/Keynote.app"] [--summary ".harvests/deck/source/export-summary.json"] [--include-source-path] [--job-file "/path/to/job.json"]'
  );
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { includeSourcePath: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--include-source-path') {
      args.includeSourcePath = true;
      continue;
    }

    const value = argv[i + 1];
    if (!value) usage();

    if (arg === '--keynote') args.keynote = value;
    else if (arg === '--out') args.out = value;
    else if (arg === '--summary') args.summary = value;
    else if (arg === '--keynote-app') args.keynoteApp = value;
    else if (arg === '--job-file') args.jobFile = value;
    else usage();
    i += 1;
  }

  if (!args.keynote || !args.out) usage();
  return args as Args;
}

function requireMacOs() {
  if (process.platform !== 'darwin') {
    throw new Error('Keynote export requires macOS with Keynote installed.');
  }
}

function requireTool(command: string) {
  const result = spawnSync('which', [command], { encoding: 'utf8', env: subprocessEnvironment(), timeout: 5000 });
  if (result.status !== 0) {
    throw new Error(`Missing required tool "${command}". Keynote export requires macOS osascript.`);
  }
}

function hasTool(command: string) {
  return spawnSync('which', [command], { encoding: 'utf8', env: subprocessEnvironment(), timeout: 5000 }).status === 0;
}

function readPlistValue(plistPath: string, key: string) {
  const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath], {
    encoding: 'utf8',
    env: subprocessEnvironment(),
    timeout: 5000,
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function appCandidate(appPath: string): KeynoteAppCandidate {
  const exists = existsSync(appPath);
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  const stats = exists ? statSync(appPath) : undefined;
  const bundleId = exists ? readPlistValue(plistPath, 'CFBundleIdentifier') : undefined;
  return {
    name: exists ? readPlistValue(plistPath, 'CFBundleDisplayName') ?? readPlistValue(plistPath, 'CFBundleName') ?? path.basename(appPath, '.app') : path.basename(appPath, '.app'),
    path: appPath,
    bundleId,
    version: exists ? readPlistValue(plistPath, 'CFBundleShortVersionString') : undefined,
    modifiedAt: stats?.mtime.toISOString(),
    exists,
    allowed: exists && isKeynoteAppPathAllowed(appPath) && isKeynoteBundleTrusted(appPath, bundleId),
  };
}

function compareVersions(a?: string, b?: string) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function discoverKeynoteApps() {
  const candidatePaths = new Set(['/Applications/Keynote.app', '/Applications/Keynote Creator Studio.app']);
  if (existsSync('/Applications')) {
    for (const entry of readdirSync('/Applications')) {
      if (entry.toLowerCase().includes('keynote') && entry.endsWith('.app')) {
        candidatePaths.add(path.join('/Applications', entry));
      }
    }
  }

  return [...candidatePaths].map(appCandidate).sort((a, b) => a.path.localeCompare(b.path));
}

function validateAppBundle(appPath: string) {
  assertKeynoteAppPathAllowed(appPath);
  if (!existsSync(appPath)) throw new Error(`Selected Keynote app not found: ${appPath}`);
  if (!statSync(appPath).isDirectory() || !appPath.endsWith('.app')) {
    throw new Error(`Selected Keynote app must be an .app bundle: ${appPath}`);
  }
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  if (!existsSync(plistPath)) throw new Error(`Selected Keynote app is missing Contents/Info.plist: ${appPath}`);
  const bundleId = readPlistValue(plistPath, 'CFBundleIdentifier');
  if (!isKeynoteBundleTrusted(appPath, bundleId)) {
    throw new Error(
      `Selected application "${path.basename(appPath)}" is not an allowed Keynote bundle${bundleId ? ` (${bundleId})` : ''}: it must carry an allowlisted bundle identifier and Apple's code signature.`
    );
  }
}

function resolveKeynoteApp(explicitAppPath?: string): KeynoteAppSelection {
  const candidates = discoverKeynoteApps();
  const configured = explicitAppPath ? path.resolve(explicitAppPath) : process.env.KEYNOTE_APP_PATH;
  if (configured) {
    const appPath = path.resolve(configured);
    validateAppBundle(appPath);
    const candidate = appCandidate(appPath);
    return {
      appPath,
      appName: candidate.name,
      bundleId: candidate.bundleId,
      version: candidate.version,
      selectionSource: explicitAppPath ? 'cli' : 'env',
      warnings: [],
      candidates: candidates.map((item) => ({ ...item, selected: item.path === appPath, recommended: item.path === appPath })),
    };
  }

  const existing = candidates.filter((candidate) => candidate.exists && candidate.allowed);
  const withVersions = existing.filter((candidate) => candidate.version);
  const sortedByVersion = [...withVersions].sort((a, b) => compareVersions(b.version, a.version));
  if (sortedByVersion.length > 0) {
    const recommended = sortedByVersion[0];
    const tied = sortedByVersion.filter((candidate) => compareVersions(candidate.version, recommended.version) === 0);
    if (tied.length === 1) {
      return {
        appPath: recommended.path,
        appName: recommended.name,
        bundleId: recommended.bundleId,
        version: recommended.version,
        selectionSource: 'discovered',
        warnings: [],
        candidates: candidates.map((item) => ({ ...item, selected: item.path === recommended.path, recommended: item.path === recommended.path })),
      };
    }
  }

  if (existing.length > 1) {
    throw new Error(
      `Multiple Keynote-like apps were found but no clear newest version could be selected. Pass --keynote-app or set KEYNOTE_APP_PATH. Candidates: ${existing
        .map((candidate) => `${candidate.path}${candidate.version ? ` (${candidate.version})` : ''}`)
        .join(', ')}`
    );
  }

  const fallbackPath = '/Applications/Keynote.app';
  validateAppBundle(fallbackPath);
  const fallback = appCandidate(fallbackPath);
  return {
    appPath: fallbackPath,
    appName: fallback.name,
    bundleId: fallback.bundleId,
    version: fallback.version,
    selectionSource: 'fallback',
    warnings: ['No clear Keynote app discovery result was available; using /Applications/Keynote.app fallback.'],
    candidates: candidates.map((item) => ({ ...item, selected: item.path === fallbackPath, recommended: item.path === fallbackPath })),
  };
}

function validateKeynotePath(keynotePath: string) {
  if (!existsSync(keynotePath)) throw new Error(`Keynote file not found: ${keynotePath}`);
  const stats = statSync(keynotePath);
  if (!stats.isFile() && !stats.isDirectory()) throw new Error(`Keynote path is not a file or package: ${keynotePath}`);
  if (!keynotePath.toLowerCase().endsWith('.key')) {
    throw new Error(`Expected a .key file or package: ${keynotePath}`);
  }
}

function pdfPageCount(pdfPath: string) {
  if (!hasTool('pdfinfo')) return undefined;
  const result = spawnSync('pdfinfo', [pdfPath], {
    encoding: 'utf8',
    env: subprocessEnvironment(),
    timeout: 30000,
  });
  if (result.status !== 0) return undefined;
  const pages = Number(result.stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
  return pages || undefined;
}

function pdfState(pdfPath: string) {
  if (!existsSync(pdfPath)) {
    return {
      pdfExists: false,
      pdfSizeBytes: undefined,
      pdfModifiedAt: undefined,
      pdfPageCount: undefined,
    };
  }

  const stats = statSync(pdfPath);
  return {
    pdfExists: stats.isFile(),
    pdfSizeBytes: stats.isFile() ? stats.size : undefined,
    pdfModifiedAt: stats.isFile() ? stats.mtime.toISOString() : undefined,
    pdfPageCount: stats.isFile() ? pdfPageCount(pdfPath) : undefined,
  };
}

function runKeynoteExport(keynotePath: string, outPath: string, keynoteAppPath: string, timeoutMs: number) {
  const script = buildKeynoteExportScript(keynoteAppPath);

  return spawnSync('osascript', ['-e', script, keynotePath, outPath], {
    encoding: 'utf8',
    env: subprocessEnvironment(),
    timeout: timeoutMs,
  });
}

function buildSummary(
  args: {
    keynotePath: string;
    outPath: string;
    statePath?: string;
    includeSourcePath: boolean;
    appSelection: KeynoteAppSelection;
    timeoutMs: number;
  },
  result: {
    status: ExportStatus;
    warnings: string[];
    timedOut: boolean;
    message: string;
  }
): ExportSummary {
  const state = pdfState(args.statePath ?? args.outPath);
  return {
    sourceType: 'keynote',
    sourceFileName: path.basename(args.keynotePath),
    sourceDisplayName: path.basename(args.keynotePath, path.extname(args.keynotePath)),
    sourcePath: args.includeSourcePath ? args.keynotePath : undefined,
    exportedPdfPath: args.outPath,
    exportTimestamp: new Date().toISOString(),
    exportStatus: result.status,
    warnings: result.warnings,
    pdfExists: state.pdfExists,
    pdfSizeBytes: state.pdfSizeBytes,
    pdfModifiedAt: state.pdfModifiedAt,
    pdfPageCount: state.pdfPageCount,
    timedOut: result.timedOut,
    message: result.message,
    tool: {
      name: 'Keynote via AppleScript',
      keynoteAppPath: args.appSelection.appPath,
      keynoteAppName: args.appSelection.appName,
      keynoteAppVersion: args.appSelection.version,
      keynoteAppBundleId: args.appSelection.bundleId,
      appSelectionSource: args.appSelection.selectionSource,
      appSelectionWarnings: args.appSelection.warnings,
      timeoutMs: args.timeoutMs,
    },
  };
}

function writeSummary(summaryPath: string, summary: ExportSummary) {
  writeFileAtomically(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

let activeJobFile: string | undefined;

function recordJob(patch: Parameters<typeof updateJobRecord>[1]) {
  if (activeJobFile) updateJobRecord(activeJobFile, patch);
}

// Phases survive in the record after completion, so a poller (or a test)
// can see what the worker did even if it never observed the phase live.
const recordedPhases: string[] = [];
function recordPhase(message: string) {
  recordedPhases.push(message);
  recordJob({ message, phases: [...recordedPhases] });
}

function main() {
  applyAugmentedToolPath();
  const args = parseArgs(process.argv.slice(2));
  activeJobFile = args.jobFile;
  recordJob({ status: 'running', pid: process.pid, message: 'Keynote export starting' });
  requireMacOs();
  requireTool('osascript');

  const keynotePath = path.resolve(args.keynote);
  const outPath = path.resolve(args.out);
  const summaryPath = path.resolve(args.summary ?? path.join(path.dirname(outPath), 'export-summary.json'));
  if (path.dirname(summaryPath) !== path.dirname(outPath) || path.basename(summaryPath) === path.basename(outPath)) {
    throw new Error('The export summary must use a different filename in the same directory as the exported PDF.');
  }
  const appSelection = resolveKeynoteApp(args.keynoteApp);
  // The osascript call has its own timeout; cap it by the total worker budget
  // so a detached export can never outlive KEYNOTE_HARVEST_COMMAND_TIMEOUT_MS.
  const timeoutMs = Math.min(Number(process.env.KEYNOTE_EXPORT_TIMEOUT_MS ?? 5 * 60 * 1000), commandTimeoutMs());

  validateKeynotePath(keynotePath);

  mkdirSync(path.dirname(outPath), { recursive: true });
  const staging = siblingTemporaryPath(outPath, '.pdf');
  const removeSignalCleanup = installStagingCleanup(staging.directory, (signal) => {
    recordJob({ status: 'failed', finishedAt: new Date().toISOString(), error: `Worker terminated by ${signal}` });
  });
  let status: ExportStatus = 'completed';
  try {
    recordPhase(`Exporting from ${appSelection.appName}`);
    const exportResult = runKeynoteExport(keynotePath, staging.filePath, appSelection.appPath, timeoutMs);
    const warnings: string[] = [...appSelection.warnings];
    let timedOut = false;
    let message = 'Keynote PDF export completed.';

    recordPhase('Verifying exported PDF');
    const output = [exportResult.stderr, exportResult.stdout].filter(Boolean).join('\n').trim();
    const stateAfterExport = pdfState(staging.filePath);
    // Marker checks (%PDF- header, trailing startxref/%%EOF) are a sanity
    // gate, not proof of validity: they catch truncation, but garbage can
    // carry them. A pdfinfo page count is the real verification.
    const popplerAvailable = hasTool('pdfinfo');
    const structurallyPlausible = Boolean(
      stateAfterExport.pdfExists &&
        stateAfterExport.pdfSizeBytes &&
        stateAfterExport.pdfSizeBytes > 0 &&
        hasPdfStructure(staging.filePath)
    );
    const verifiedPdf = structurallyPlausible && popplerAvailable && (stateAfterExport.pdfPageCount ?? 0) >= 1;
    // On the success path Keynote itself vouched for the export, so marker
    // checks suffice when no validator is installed. After an error or
    // timeout, output is promoted only when a real validator confirms it —
    // otherwise the previous export is preserved.
    const hasValidNewPdf = popplerAvailable ? verifiedPdf : structurallyPlausible;
    const unverifiableNote =
      'Keynote reported a problem and Poppler (pdfinfo) is not installed to verify the written PDF; keeping the previous export. Install Poppler to allow verified recovery of partial exports.';

    if (exportResult.error) {
      timedOut = exportResult.error.message.includes('ETIMEDOUT');
      if (timedOut && verifiedPdf) {
        status = 'completed-with-warning';
        message = 'Keynote automation timed out after writing a verified PDF. Continuing with the exported PDF.';
        warnings.push(message);
      } else {
        status = 'failed';
        message = timedOut
          ? `Keynote PDF export timed out before a verified PDF was produced.${!popplerAvailable && structurallyPlausible ? ` ${unverifiableNote}` : ''}`
          : exportResult.error.message;
      }
    } else if (exportResult.status !== 0) {
      timedOut = output.includes('(-1712)') || output.toLowerCase().includes('timed out');
      if (verifiedPdf) {
        status = 'completed-with-warning';
        message = 'Keynote automation returned an error after writing a verified PDF. Continuing with the exported PDF.';
        warnings.push(message);
        if (output) warnings.push(output);
      } else if (!popplerAvailable && structurallyPlausible) {
        status = 'failed';
        message = [unverifiableNote, output].filter(Boolean).join(' ');
      } else {
        status = 'failed';
        message = [
          'Keynote PDF export failed.',
          'Make sure Keynote is installed and macOS Automation permissions allow this terminal or host app to control Keynote.',
          output,
        ]
          .filter(Boolean)
          .join(' ');
      }
    }

    if (status === 'completed' && !hasValidNewPdf) {
      status = 'failed';
      message = `Keynote reported success, but no valid PDF was written: ${path.basename(outPath)}`;
    }

    const stagedPdfPath = path.join(staging.directory, path.basename(outPath));
    if (status !== 'failed' && stagedPdfPath !== staging.filePath) renameSync(staging.filePath, stagedPdfPath);
    const summary = buildSummary(
      {
        keynotePath,
        outPath,
        statePath: status === 'failed' ? staging.filePath : stagedPdfPath,
        includeSourcePath: args.includeSourcePath,
        appSelection,
        timeoutMs,
      },
      { status, warnings, timedOut, message }
    );
    if (status !== 'failed') {
      recordPhase('Replacing outputs');
      const stagedSummaryPath = path.join(staging.directory, path.basename(summaryPath));
      writeSummary(stagedSummaryPath, summary);
      replaceManagedOutputs(path.dirname(outPath), staging.directory, [
        path.basename(outPath),
        path.basename(summaryPath),
      ]);
    }
    recordJob({
      status: status === 'failed' ? 'failed' : 'completed',
      finishedAt: new Date().toISOString(),
      message,
      ...(status === 'failed' ? { error: message } : {}),
    });
    console.log(JSON.stringify({ ...summary, summaryPath }, null, 2));
  } finally {
    removeSignalCleanup();
    rmSync(staging.directory, { recursive: true, force: true });
  }

  if (status === 'failed') process.exitCode = 1;
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // Log first, then flip the job to its terminal state: readers that see
  // "failed" must also find the explanation already on disk.
  console.error(message);
  recordJob({ status: 'failed', finishedAt: new Date().toISOString(), error: message });
  process.exit(1);
}
