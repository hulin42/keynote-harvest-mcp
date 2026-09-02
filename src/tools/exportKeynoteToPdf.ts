import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  exportResponsePathExposure,
  pathExposureForMode,
  redactLocalPath,
  toHarvestRelativePath,
  toDisplaySourceName,
  type LocalPathRedactionMode,
} from '../lib/pathPolicy.js';
import { harvestSlugSchema, parseToolArgs } from '../lib/toolArgs.js';
import {
  assertHarvestSlug,
  assertOutPathWithinHarvestRoot,
  assertOutsideHarvestRootAllowed,
  cliPath,
  defaultHarvestOutDir,
  harvestRoot,
  resolveFromWorkingDirectory,
} from '../lib/paths.js';
import {
  assertInputPathAllowed,
  assertKeynoteAppPathAllowed,
  assertLocalDebugAllowed,
  redactDisplayText,
} from '../lib/securityPolicy.js';
import { launchBackgroundJob } from '../lib/jobs.js';
import { ProgressTracker, type ProgressReporter } from '../lib/progress.js';
import { CommandExecutionError, runCommand } from '../lib/runCommand.js';

type ExportSummary = {
  sourceType: 'keynote';
  sourceFileName: string;
  sourceDisplayName: string;
  sourcePath?: string;
  exportedPdfPath: string;
  exportTimestamp: string;
  exportStatus: 'completed' | 'completed-with-warning' | 'failed';
  warnings: string[];
  pdfExists: boolean;
  pdfSizeBytes?: number;
  pdfModifiedAt?: string;
  pdfPageCount?: number;
  timedOut: boolean;
  message: string;
  summaryPath: string;
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

export const exportKeynoteToPdfTool = {
  name: 'export_keynote_to_pdf',
  description: 'Export a native Keynote .key file to PDF using macOS Keynote automation.',
  inputSchema: {
    keynotePath: z.string().min(1).max(4096).describe('Path to the .key file or package to export.'),
    outPath: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        'Where to write the exported PDF. Must stay inside the harvest root unless allowOutsideHarvestRoot is true. Defaults to <harvest root>/<slug>/source/<slug>.pdf.'
      ),
    slug: harvestSlugSchema.optional(),
    title: z.string().min(1).max(500).optional(),
    keynoteAppPath: z.string().min(1).max(4096).optional(),
    runInBackground: z
      .boolean()
      .optional()
      .describe(
        'Return immediately and run the Keynote export as a detached background job. Poll get_harvest_manifest with the same slug for status. Use on hosts that cap tool-call duration.'
      ),
    redactionMode: z.enum(['display', 'local-debug']).optional(),
    allowOutsideHarvestRoot: z
      .boolean()
      .optional()
      .describe(
        'Request writing outPath outside the harvest root. Defaults to false. This argument alone is insufficient: the operator must also set KEYNOTE_HARVEST_ALLOW_OUTSIDE_ROOT=1 in the server environment, otherwise the call is rejected.'
      ),
  },
  annotations: {
    title: 'Export Keynote to PDF',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
};

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseArgs(args: unknown) {
  return parseToolArgs(exportKeynoteToPdfTool.name, exportKeynoteToPdfTool.inputSchema, args);
}

export function defaultExportPdfPath(args: { keynotePath: string; outPath?: string; slug?: string; title?: string }) {
  if (args.outPath) return resolveFromWorkingDirectory(args.outPath);
  const sourceName = path.basename(args.keynotePath, path.extname(args.keynotePath));
  const slug = assertHarvestSlug(args.slug ?? slugify(args.title ?? sourceName));
  return path.join(defaultHarvestOutDir(slug), 'source', `${slug}.pdf`);
}

function displaySafeTool(tool: ExportSummary['tool'] | undefined) {
  if (!tool) return undefined;
  const { keynoteAppPath, ...displaySafe } = tool;
  void keynoteAppPath;
  return displaySafe;
}

function redactMessage(message: string, sensitivePaths: Array<string | undefined>) {
  return redactDisplayText(message, sensitivePaths);
}

function withLocalDebug<T extends Record<string, unknown>>(
  response: T,
  redactionMode: LocalPathRedactionMode,
  localDebug: Record<string, unknown>
) {
  return redactionMode === 'local-debug' ? { ...response, localDebug } : response;
}

function parseExportSummary(output: string) {
  try {
    return JSON.parse(output) as ExportSummary;
  } catch {
    return undefined;
  }
}

export async function exportKeynoteToPdf(args: unknown, onProgress?: ProgressReporter) {
  const parsed = parseArgs(args);
  const redactionMode = parsed.redactionMode ?? 'display';
  assertLocalDebugAllowed(redactionMode);
  const keynotePath = resolveFromWorkingDirectory(parsed.keynotePath);
  assertInputPathAllowed(keynotePath, 'Keynote input');
  const sourceName = path.basename(keynotePath, path.extname(keynotePath));
  const slug = assertHarvestSlug(parsed.slug ?? slugify(parsed.title ?? sourceName));
  const exportedPdfPath = defaultExportPdfPath({ ...parsed, keynotePath, slug });
  // Containment runs on every resolved output path, default included: a symlink
  // planted at <harvestRoot>/<slug> would otherwise let the default export path
  // escape the root with no explicit outPath. The outside-root escape is honored
  // only for an explicit outPath plus the operator environment opt-in.
  if (parsed.outPath && parsed.allowOutsideHarvestRoot) {
    assertOutsideHarvestRootAllowed();
  } else {
    assertOutPathWithinHarvestRoot(exportedPdfPath);
    const expectedSourceDirectory = path.join(defaultHarvestOutDir(slug), 'source');
    if (path.resolve(path.dirname(exportedPdfPath)) !== path.resolve(expectedSourceDirectory)) {
      throw new Error('Contained Keynote exports must use <harvest root>/<slug>/source/<file>.pdf.');
    }
  }
  if (path.extname(exportedPdfPath).toLowerCase() !== '.pdf') throw new Error('Keynote export output must use the .pdf extension.');
  const summaryPath = path.join(path.dirname(exportedPdfPath), 'export-summary.json');
  const exportedPdfHarvestPath = toHarvestRelativePath(exportedPdfPath, harvestRoot());
  const summaryHarvestPath = toHarvestRelativePath(summaryPath, harvestRoot());
  const keynoteAppPath = parsed.keynoteAppPath
    ? assertKeynoteAppPathAllowed(resolveFromWorkingDirectory(parsed.keynoteAppPath))
    : undefined;
  const responseFromSummary = (
    summary: ExportSummary,
    commandDebug?: { stdout?: string; stderr?: string; error?: string }
  ) => {
    const sensitivePaths = [keynotePath, exportedPdfPath, summaryPath, summary.tool.keynoteAppPath];
    return withLocalDebug({
      responseKind: 'export-summary',
      success: summary.exportStatus !== 'failed',
      sourceType: summary.sourceType,
      sourceDisplayName: summary.sourceDisplayName,
      redactedSourceFileName: summary.sourceFileName,
      slug,
      exportedPdfHarvestPath,
      summaryHarvestPath,
      exportStatus: summary.exportStatus,
      exportWarnings: summary.warnings.map((warning) => redactMessage(warning, sensitivePaths)),
      pdfExists: summary.pdfExists,
      pdfSizeBytes: summary.pdfSizeBytes,
      pdfModifiedAt: summary.pdfModifiedAt,
      pdfPageCount: summary.pdfPageCount,
      timedOut: summary.timedOut,
      previousOutputPreserved: summary.exportStatus === 'failed' && existsSync(exportedPdfPath),
      message: redactMessage(summary.message, sensitivePaths),
      tool: displaySafeTool(summary.tool),
      selectedKeynoteAppName: summary.tool.keynoteAppName,
      selectedKeynoteAppVersion: summary.tool.keynoteAppVersion,
      selectedKeynoteAppBundleId: summary.tool.keynoteAppBundleId,
      appSelectionSource: summary.tool.appSelectionSource,
      appSelectionWarnings: summary.tool.appSelectionWarnings.map((warning) => redactMessage(warning, sensitivePaths)),
      redactionMode,
      pathExposure: pathExposureForMode(exportResponsePathExposure, redactionMode),
    }, redactionMode, {
      sourceKeynoteLocalPath: keynotePath,
      exportedPdfLocalPath: exportedPdfPath,
      exportSummaryLocalPath: summaryPath,
      selectedKeynoteAppLocalPath: summary.tool.keynoteAppPath,
      tool: summary.tool,
      ...commandDebug,
    });
  };

  // The export is one long osascript call with no incremental output, so
  // progress is a time-based heartbeat that keeps host request timeouts alive.
  const tracker = new ProgressTracker(onProgress);
  const stopHeartbeat = tracker.startHeartbeat('Keynote export in progress');
  let command;
  try {
    const commandArgs = [
      cliPath('export-keynote-to-pdf.js'),
      '--keynote',
      keynotePath,
      '--out',
      exportedPdfPath,
      '--summary',
      summaryPath,
    ];
    if (keynoteAppPath) {
      commandArgs.push('--keynote-app', keynoteAppPath);
    }
    if (parsed.runInBackground) {
      const job = launchBackgroundJob({
        slug,
        kind: 'export',
        commandArgs,
        result: { exportedPdfHarvestPath, summaryHarvestPath },
      });
      return {
        responseKind: 'job-record',
        status: 'running',
        background: true,
        kind: 'export',
        slug,
        startedAt: job.startedAt,
        jobHarvestPath: job.jobHarvestPath,
        exportedPdfHarvestPath,
        summaryHarvestPath,
        note: 'Background Keynote export started. Call get_harvest_manifest with this slug to poll its status; when it reports completed, pass exportedPdfHarvestPath to harvest_keynote_pdf.',
        redactionMode,
      };
    }
    command = await runCommand(process.execPath, commandArgs);
  } catch (error) {
    if (error instanceof CommandExecutionError) {
      const failedSummary = parseExportSummary(error.stdout);
      if (failedSummary) {
        return responseFromSummary(failedSummary, {
          stdout: error.stdout.trim(),
          stderr: error.stderr.trim(),
          error: error.message,
        });
      }
    }

    const commandError = error instanceof CommandExecutionError ? error : undefined;
    const errorMessage = redactMessage(
      commandError?.stderr.trim() || (error instanceof Error ? error.message : String(error)),
      [keynotePath, exportedPdfPath, summaryPath, keynoteAppPath]
    );
    return withLocalDebug({
      responseKind: 'export-summary',
      success: false,
      sourceType: 'keynote',
      sourceDisplayName: parsed.title ?? toDisplaySourceName(keynotePath),
      redactedSourceFileName: redactLocalPath(keynotePath),
      slug,
      exportedPdfHarvestPath,
      summaryHarvestPath,
      exportStatus: 'failed',
      exportWarnings: [],
      pdfExists: false,
      previousOutputPreserved: existsSync(exportedPdfPath),
      timedOut: commandError?.timedOut ?? errorMessage.includes('timed out'),
      message: errorMessage,
      redactionMode,
      pathExposure: pathExposureForMode(exportResponsePathExposure, redactionMode),
    }, redactionMode, {
      sourceKeynoteLocalPath: keynotePath,
      exportedPdfLocalPath: exportedPdfPath,
      exportSummaryLocalPath: summaryPath,
      selectedKeynoteAppLocalPath: keynoteAppPath,
      error: error instanceof Error ? error.message : String(error),
      stdout: commandError?.stdout.trim(),
      stderr: commandError?.stderr.trim(),
    });
  } finally {
    stopHeartbeat();
  }

  const summary = JSON.parse(command.stdout) as ExportSummary;
  if (summary.pdfSizeBytes === undefined && existsSync(exportedPdfPath)) {
    summary.pdfSizeBytes = statSync(exportedPdfPath).size;
  }
  return responseFromSummary(summary, {
    stdout: command.stdout.trim(),
    stderr: command.stderr.trim(),
  });
}
