import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { replaceManagedOutputs } from '../lib/atomicFiles.js';
import { updateJobRecord } from '../lib/jobs.js';
import { assertHarvestSlug } from '../lib/paths.js';
import { assertOutputWithinLimit } from '../lib/resourceLimits.js';
import { commandTimeoutMs } from '../lib/runCommand.js';
import { installStagingCleanup, sweepStaleStaging } from '../lib/stagingCleanup.js';
import {
  assertInputFileSize,
  maxCommandOutputBytes,
  popplerTimeoutMs,
  redactDisplayText,
  subprocessEnvironment,
} from '../lib/securityPolicy.js';
import { applyAugmentedToolPath } from '../lib/toolPath.js';
import { validateKeynoteHarvestManifest } from '../schema/validateManifest.js';
import { CURRENT_KEYNOTE_HARVEST_MANIFEST_VERSION } from '../schema/version.js';
import type {
  HarvestSourceKind,
  KeynoteHarvestAsset,
  KeynoteHarvestExportMetadata,
  KeynoteHarvestManifest,
  KeynoteHarvestSlide,
  KeynoteHarvestTextRun,
  KeynoteHarvestWarning,
} from '../types/keynote-harvest.js';

type Args = {
  pdf: string;
  slug: string;
  title: string;
  out: string;
  extractImages: boolean;
  extractImagesSource: 'default' | 'cli';
  previewDpi: number;
  maxPages: number;
  sourceKind: HarvestSourceKind;
  sourceSummary?: string;
  resourceUriBase?: string;
  jobFile?: string;
};

type PageSize = {
  width: number;
  height: number;
  aspectRatio: string;
};

type PdfInfo = PageSize & {
  pages: number;
  pageSizes: Map<number, PageSize>;
};

const REQUIRED_TOOLS = ['pdfinfo', 'pdftoppm', 'pdftotext'];
const DEFAULT_MAX_EXTRACTED_ASSETS = 2000;
const DEFAULT_MAX_ASSET_PIXELS = 100_000_000;
const DEFAULT_MAX_PREVIEW_PIXELS = 40_000_000;
const MIN_PREVIEW_DPI = 36;

function positiveIntegerSetting(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function usage(): never {
  throw new Error(
    'Usage: node dist/cli/harvest-keynote-pdf.js --pdf "/path/to/deck.pdf" --slug "deck-slug" --title "Deck Title" --out ".harvests/deck-slug" [--source-kind pdf|edited-pdf|keynote|unknown] [--source-summary ".harvests/deck/source/export-summary.json"] [--resource-uri-base "keynote-harvest://deck-slug"] [--preview-dpi 144] [--max-pages 300] [--extract-images|--no-extract-images] [--job-file "/path/to/job.json"]'
  );
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {
    extractImages: true,
    extractImagesSource: 'default',
    previewDpi: 144,
    maxPages: 300,
    sourceKind: 'pdf',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--extract-images') {
      args.extractImages = true;
      args.extractImagesSource = 'cli';
      continue;
    }
    if (arg === '--no-extract-images') {
      args.extractImages = false;
      args.extractImagesSource = 'cli';
      continue;
    }

    const value = argv[i + 1];
    if (!value) usage();

    if (arg === '--pdf') args.pdf = value;
    else if (arg === '--slug') args.slug = value;
    else if (arg === '--title') args.title = value;
    else if (arg === '--out') args.out = value;
    else if (arg === '--preview-dpi') args.previewDpi = Number(value);
    else if (arg === '--max-pages') args.maxPages = Number(value);
    else if (arg === '--source-kind') args.sourceKind = value as HarvestSourceKind;
    else if (arg === '--source-summary') args.sourceSummary = value;
    else if (arg === '--resource-uri-base') args.resourceUriBase = value;
    else if (arg === '--job-file') args.jobFile = value;
    else usage();
    i += 1;
  }

  if (!args.pdf || !args.slug || !args.title || !args.out) usage();
  assertHarvestSlug(args.slug);
  if (!['keynote', 'pdf', 'edited-pdf', 'unknown'].includes(args.sourceKind ?? '')) {
    throw new Error(`Invalid source kind: ${args.sourceKind}`);
  }
  if (!Number.isInteger(args.previewDpi) || (args.previewDpi ?? 0) < 36 || (args.previewDpi ?? 0) > 600) {
    throw new Error(`Invalid preview DPI: ${args.previewDpi}. Use an integer between 36 and 600.`);
  }
  if (!Number.isInteger(args.maxPages) || (args.maxPages ?? 0) < 1 || (args.maxPages ?? 0) > 2000) {
    throw new Error(`Invalid max pages: ${args.maxPages}. Use an integer between 1 and 2000.`);
  }
  return args as Args;
}

// Detached workers are not under runCommand's process-group timeout, so
// they enforce the same total budget themselves between bounded steps.
const workerDeadline = Date.now() + commandTimeoutMs();
function assertWithinBudget(stage: string, force = false) {
  if (!force && Date.now() <= workerDeadline) return;
  throw new Error(
    `Harvest exceeded the ${commandTimeoutMs()}ms total budget (KEYNOTE_HARVEST_COMMAND_TIMEOUT_MS) during ${stage}. Raise the budget, lower previewDpi, or disable image extraction for this deck.`
  );
}

function run(command: string, args: string[], options?: { allowFailure?: boolean }) {
  // Each call is bounded by the Poppler limit AND by whatever remains of the
  // worker's total budget, so a detached worker cannot overrun it by a full
  // Poppler timeout.
  const remainingMs = workerDeadline - Date.now();
  if (remainingMs <= 0) assertWithinBudget(command);
  const budgetBound = remainingMs < popplerTimeoutMs();
  const timeoutMs = budgetBound ? Math.max(50, remainingMs) : popplerTimeoutMs();
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: subprocessEnvironment(),
    timeout: timeoutMs,
    maxBuffer: maxCommandOutputBytes(),
  });
  if (result.error) {
    const timedOut = result.error.message.includes('ETIMEDOUT');
    // When the remaining total budget was the binding limit, report the
    // budget — that is the cause the operator can act on.
    if (timedOut && budgetBound) assertWithinBudget(command, true);
    throw new Error(timedOut ? `${command} timed out after ${timeoutMs}ms.` : `${command} could not be started.`);
  }
  if (result.status !== 0 && !options?.allowFailure) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return result;
}

function hasTool(command: string) {
  return spawnSync('which', [command], {
    encoding: 'utf8',
    env: subprocessEnvironment(),
    timeout: 5000,
  }).status === 0;
}

function requireTool(command: string) {
  if (!hasTool(command)) {
    throw new Error(
      `Missing required PDF tool "${command}". Install Poppler, for example: brew install poppler. If Poppler is installed but the MCP host launches with a minimal PATH, set KEYNOTE_HARVEST_POPPLER_PATH to the directory containing the Poppler binaries.`
    );
  }
}

function parsePdfInfo(pdfPath: string): PdfInfo {
  // Pages in one PDF can have different sizes, so ask pdfinfo for every
  // page's dimensions (the -f/-l form prints one "Page N size:" line each).
  const result = run('pdfinfo', ['-f', '1', '-l', '2000', pdfPath]);
  const output = result.stdout;
  const pages = Number(output.match(/^Pages:\s+(\d+)/m)?.[1]);

  const pageSizes = new Map<number, PageSize>();
  for (const match of output.matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/gm)) {
    const width = Math.round(Number(match[2]));
    const height = Math.round(Number(match[3]));
    pageSizes.set(Number(match[1]), { width, height, aspectRatio: `${width}:${height}` });
  }

  const firstPage = pageSizes.get(1);
  if (!pages || !firstPage) {
    throw new Error('Could not read PDF page count or dimensions from pdfinfo output.');
  }

  return { pages, pageSizes, ...firstPage };
}

function resourceBase(args: Args) {
  return args.resourceUriBase ?? `${process.env.KEYNOTE_HARVEST_RESOURCE_SCHEME ?? 'keynote-harvest'}://${args.slug}`;
}

function renderPreview(pdfPath: string, page: number, previewsDir: string, dpi: number) {
  const basename = `slide-${String(page).padStart(3, '0')}`;
  const prefix = path.join(previewsDir, basename);
  run('pdftoppm', ['-png', '-r', String(dpi), '-f', String(page), '-l', String(page), '-singlefile', pdfPath, prefix]);
  const rendered = `${prefix}.png`;
  if (!existsSync(rendered)) {
    throw new Error(`Expected rendered preview not found: ${rendered}`);
  }
  return rendered;
}

function extractText(pdfPath: string, page: number, textDir: string) {
  const textPath = path.join(textDir, `slide-${String(page).padStart(3, '0')}.txt`);
  run('pdftotext', ['-f', String(page), '-l', String(page), pdfPath, textPath]);
  return readFileSync(textPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function toTextRuns(slideId: string, lines: string[]): KeynoteHarvestTextRun[] {
  return lines.map((text, index) => ({
    id: `${slideId}-text-${index + 1}`,
    text,
    role: index === 0 ? 'title' : 'body',
    source: 'pdf-text',
    confidence: 1,
  }));
}

function parseImageList(pdfPath: string, lastPage: number) {
  const result = run('pdfimages', ['-list', '-f', '1', '-l', String(lastPage), pdfPath], { allowFailure: true });
  if (result.status !== 0) return [];

  return result.stdout
    .split('\n')
    .slice(2)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 15 && cols[2] === 'image')
    .map((cols) => ({
      page: Number(cols[0]),
      num: Number(cols[1]),
      width: Number(cols[3]),
      height: Number(cols[4]),
      size: cols[14],
    }))
    .filter((row) => row.page >= 1 && row.page <= lastPage);
}

function extractImages(pdfPath: string, args: Args, assetsDir: string, lastPage: number): KeynoteHarvestAsset[] {
  const imageRows = parseImageList(pdfPath, lastPage);
  if (imageRows.length === 0) return [];
  const maxAssets = positiveIntegerSetting('KEYNOTE_HARVEST_MAX_EXTRACTED_ASSETS', DEFAULT_MAX_EXTRACTED_ASSETS);
  if (imageRows.length > maxAssets) {
    throw new Error(`PDF contains ${imageRows.length} embedded images, over the ${maxAssets}-asset extraction limit.`);
  }
  const maxAssetPixels = positiveIntegerSetting('KEYNOTE_HARVEST_MAX_ASSET_PIXELS', DEFAULT_MAX_ASSET_PIXELS);
  const oversized = imageRows.find((row) => row.width * row.height > maxAssetPixels);
  if (oversized) {
    throw new Error(
      `Embedded image ${oversized.num} on page ${oversized.page} exceeds the ${maxAssetPixels}-pixel asset limit.`
    );
  }

  const prefix = path.join(assetsDir, 'asset');
  run('pdfimages', ['-png', '-f', '1', '-l', String(lastPage), pdfPath, prefix], { allowFailure: true });

  return imageRows
    .map((row): KeynoteHarvestAsset | null => {
      const generated = path.join(assetsDir, `asset-${String(row.num).padStart(3, '0')}.png`);
      if (!existsSync(generated)) return null;

      const sourceSlideId = `slide-${String(row.page).padStart(3, '0')}`;
      const stableName = `${sourceSlideId}-asset-${String(row.num).padStart(3, '0')}.png`;
      const stablePath = path.join(assetsDir, stableName);
      renameSync(generated, stablePath);

      return {
        id: `${sourceSlideId}-asset-${String(row.num).padStart(3, '0')}`,
        kind: 'embedded-image' as const,
        path: `${resourceBase(args)}/assets/${stableName}`,
        sourceSlideId,
        alt: `Extracted image ${row.num} from page ${row.page}.`,
        width: row.width,
        height: row.height,
        mimeType: 'image/png',
      };
    })
    .filter((asset): asset is KeynoteHarvestAsset => Boolean(asset));
}

type ExportSummaryFile = {
  sourceType?: HarvestSourceKind;
  sourceFileName?: string;
  sourceDisplayName?: string;
  sourcePath?: string;
  exportedPdfPath?: string;
  exportTimestamp?: string;
  exportStatus?: 'completed' | 'completed-with-warning' | 'failed';
  warnings?: string[];
  pdfSizeBytes?: number;
  pdfModifiedAt?: string;
  pdfPageCount?: number;
  timedOut?: boolean;
  tool?: {
    name?: string;
    keynoteAppPath?: string;
    keynoteAppName?: string;
    keynoteAppVersion?: string;
    keynoteAppBundleId?: string;
    appSelectionSource?: 'cli' | 'env' | 'discovered' | 'fallback';
    appSelectionWarnings?: string[];
  };
};

function readExportSummary(args: Args): ExportSummaryFile | undefined {
  if (!args.sourceSummary) return undefined;
  const summaryPath = path.resolve(args.sourceSummary);
  if (!existsSync(summaryPath)) throw new Error(`Source export summary not found: ${summaryPath}`);
  return JSON.parse(readFileSync(summaryPath, 'utf8')) as ExportSummaryFile;
}

function exportMetadata(args: Args, pdfPath: string, info: PdfInfo, summary?: ExportSummaryFile): KeynoteHarvestExportMetadata | undefined {
  if (!summary) {
    return args.sourceKind === 'edited-pdf'
      ? {
          sourceKind: 'edited-pdf',
          sourceDisplayName: args.title,
          redactedSourceFileName: path.basename(pdfPath),
          redactedExportedPdfFileName: path.basename(pdfPath),
          pdfPageCount: info.pages,
          pdfSizeBytes: statSync(pdfPath).size,
          pdfModifiedAt: statSync(pdfPath).mtime.toISOString(),
          manuallyEditedPdfArtifact: true,
        }
      : undefined;
  }

  return {
    sourceKind: summary.sourceType ?? args.sourceKind,
    sourceDisplayName: summary.sourceDisplayName ?? args.title,
    redactedSourceFileName: summary.sourceFileName,
    redactedExportedPdfFileName: path.basename(summary.exportedPdfPath ?? pdfPath),
    exportedAt: summary.exportTimestamp,
    exportTool: summary.tool?.name,
    selectedKeynoteAppName: summary.tool?.keynoteAppName,
    selectedKeynoteAppVersion: summary.tool?.keynoteAppVersion,
    selectedKeynoteAppBundleId: summary.tool?.keynoteAppBundleId,
    appSelectionSource: summary.tool?.appSelectionSource,
    appSelectionWarnings: summary.tool?.appSelectionWarnings?.map((warning) =>
      redactDisplayText(warning, [summary.sourcePath, summary.exportedPdfPath, summary.tool?.keynoteAppPath])
    ),
    exportStatus: summary.exportStatus,
    exportWarnings: summary.warnings?.map((warning) =>
      redactDisplayText(warning, [summary.sourcePath, summary.exportedPdfPath, summary.tool?.keynoteAppPath])
    ),
    pdfPageCount: summary.pdfPageCount ?? info.pages,
    pdfSizeBytes: summary.pdfSizeBytes,
    pdfModifiedAt: summary.pdfModifiedAt,
    timedOut: summary.timedOut,
    manuallyEditedPdfArtifact: summary.sourceType === 'edited-pdf' || args.sourceKind === 'edited-pdf',
  };
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
  recordJob({ status: 'running', pid: process.pid, message: 'Harvest starting' });
  for (const tool of REQUIRED_TOOLS) requireTool(tool);
  if (args.extractImages && args.extractImagesSource === 'cli') requireTool('pdfimages');
  const extractEmbeddedImages = args.extractImages && hasTool('pdfimages');

  const pdfPath = path.resolve(args.pdf);
  if (!existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
  if (!statSync(pdfPath).isFile()) throw new Error(`PDF path is not a file: ${pdfPath}`);
  assertInputFileSize(pdfPath, 'PDF input');

  const outDir = path.resolve(args.out);
  mkdirSync(path.dirname(outDir), { recursive: true });
  // Leftovers from workers that were hard-killed outlive the command timeout;
  // clear them before staging a new run for the same destination.
  sweepStaleStaging(outDir, commandTimeoutMs());
  const stagingDir = mkdtempSync(path.join(path.dirname(outDir), `.${path.basename(outDir)}.staging-`));
  const removeSignalCleanup = installStagingCleanup(stagingDir, (signal) => {
    recordJob({ status: 'failed', finishedAt: new Date().toISOString(), error: `Worker terminated by ${signal}` });
  });
  try {
  const previewsDir = path.join(stagingDir, 'previews');
  const textDir = path.join(stagingDir, 'text');
  const assetsDir = path.join(stagingDir, 'assets');
  mkdirSync(previewsDir, { recursive: true });
  mkdirSync(textDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });

  const info = parsePdfInfo(pdfPath);
  const summary = readExportSummary(args);
  const sourceKind = summary?.sourceType ?? args.sourceKind;
  const sourceDisplayName = summary?.sourceDisplayName ?? args.title;
  const redactedSourceFileName = summary?.sourceFileName ?? path.basename(pdfPath);
  const sourceExportMetadata = exportMetadata(args, pdfPath, info, summary);
  const warnings: KeynoteHarvestWarning[] = [];
  const slides: KeynoteHarvestSlide[] = [];
  const harvestedPages = Math.min(info.pages, args.maxPages);

  // Bound rendered pixels before Poppler runs: page dimensions come from the
  // input PDF, so DPI alone does not cap the output size. Pages can differ in
  // size, so the budget is applied to each page's own dimensions.
  const maxPreviewPixels = positiveIntegerSetting('KEYNOTE_HARVEST_MAX_PREVIEW_PIXELS', DEFAULT_MAX_PREVIEW_PIXELS);
  const previewDpiByPage = new Map<number, number>();
  const clampedPages: number[] = [];
  for (let page = 1; page <= harvestedPages; page += 1) {
    const size = info.pageSizes.get(page) ?? info;
    const pixelsAt = (dpi: number) => Math.ceil((size.width / 72) * dpi) * Math.ceil((size.height / 72) * dpi);
    let pageDpi = args.previewDpi;
    if (pixelsAt(pageDpi) > maxPreviewPixels) {
      pageDpi = Math.floor(Math.sqrt(maxPreviewPixels / ((size.width / 72) * (size.height / 72))));
      if (pageDpi < MIN_PREVIEW_DPI) {
        throw new Error(
          `Page ${page} is ${size.width}x${size.height} points, over the ${maxPreviewPixels}-pixel preview render budget even at ${MIN_PREVIEW_DPI} DPI. Raise KEYNOTE_HARVEST_MAX_PREVIEW_PIXELS to harvest this PDF.`
        );
      }
      clampedPages.push(page);
    }
    previewDpiByPage.set(page, pageDpi);
  }
  if (clampedPages.length > 0) {
    warnings.push({
      id: 'warning-preview-dpi-clamped',
      code: 'unknown',
      severity: 'warning',
      message: `Preview DPI was lowered below ${args.previewDpi} on ${clampedPages.length} page(s) (${clampedPages.slice(0, 10).join(', ')}${clampedPages.length > 10 ? ', …' : ''}) to stay within the ${maxPreviewPixels}-pixel render budget (KEYNOTE_HARVEST_MAX_PREVIEW_PIXELS).`,
    });
  }
  if (harvestedPages < info.pages) {
    warnings.push({
      id: 'warning-max-pages-truncated',
      code: 'unknown',
      severity: 'warning',
      message: `The PDF has ${info.pages} pages; only the first ${harvestedPages} were harvested (--max-pages ${args.maxPages}). Re-run with a higher --max-pages to harvest the rest.`,
    });
  }

  // Machine-readable progress on stderr for the MCP tool layer; stdout stays
  // reserved for the human-readable result.
  console.error(`KEYNOTE_HARVEST_PROGRESS ${JSON.stringify({ page: 0, total: harvestedPages })}`);
  recordJob({ progress: { page: 0, total: harvestedPages } });
  recordPhase('Rendering pages');
  for (let page = 1; page <= harvestedPages; page += 1) {
    const slideId = `slide-${String(page).padStart(3, '0')}`;
    const pageSize = info.pageSizes.get(page) ?? info;
    assertWithinBudget(`page ${page} of ${harvestedPages}`);
    const previewPath = renderPreview(pdfPath, page, previewsDir, previewDpiByPage.get(page) ?? args.previewDpi);
    const textLines = extractText(pdfPath, page, textDir);
    assertOutputWithinLimit(stagingDir);
    console.error(`KEYNOTE_HARVEST_PROGRESS ${JSON.stringify({ page, total: harvestedPages })}`);
    recordJob({ progress: { page, total: harvestedPages }, message: `Harvested page ${page} of ${harvestedPages}` });

    if (textLines.length === 0) {
      warnings.push({
        id: `warning-no-text-${slideId}`,
        code: 'failed-extraction',
        severity: 'info',
        message: `No extractable text found on page ${page}. OCR is not implemented.`,
        slideId,
      });
    }

    slides.push({
      id: slideId,
      index: page,
      title: textLines[0] ?? `Slide ${page}`,
      dimensions: { width: pageSize.width, height: pageSize.height, aspectRatio: pageSize.aspectRatio },
      preview: {
        id: `preview-${slideId}`,
        slideId,
        path: `${resourceBase(args)}/previews/${path.basename(previewPath)}`,
        width: pageSize.width,
        height: pageSize.height,
        mimeType: 'image/png',
      },
      textRuns: toTextRuns(slideId, textLines),
      assetIds: [],
    });
  }

  assertWithinBudget('image extraction');
  if (extractEmbeddedImages) recordPhase('Extracting embedded images');
  const assets = extractEmbeddedImages ? extractImages(pdfPath, args, assetsDir, harvestedPages) : [];
  assertOutputWithinLimit(stagingDir);
  if (!args.extractImages) {
    warnings.push({
      id: 'warning-embedded-images-not-extracted',
      code: 'unsupported-media',
      severity: 'info',
      message: 'Embedded image extraction was disabled with --no-extract-images. Re-run without it to use pdfimages.',
    });
  } else if (!extractEmbeddedImages) {
    warnings.push({
      id: 'warning-embedded-images-not-extracted',
      code: 'unsupported-media',
      severity: 'warning',
      message: 'Embedded image extraction was skipped because the Poppler "pdfimages" command is not installed. Install Poppler (for example: brew install poppler) and re-run to extract embedded images.',
    });
  }

  const assetIdsBySlide = new Map<string, string[]>();
  for (const asset of assets) {
    const ids = assetIdsBySlide.get(asset.sourceSlideId) ?? [];
    ids.push(asset.id);
    assetIdsBySlide.set(asset.sourceSlideId, ids);
  }

  const slidesWithAssets = slides.map((slide) => ({
    ...slide,
    assetIds: assetIdsBySlide.get(slide.id) ?? [],
  }));

  const manifest: KeynoteHarvestManifest = {
    schemaVersion: CURRENT_KEYNOTE_HARVEST_MANIFEST_VERSION,
    id: `harvest-${args.slug}`,
    deckTitle: args.title,
    source: {
      id: `source-${args.slug}-${sourceKind}`,
      kind: sourceKind,
      title: args.title,
      displayName: sourceDisplayName,
      redactedSourceFileName,
      harvestedAt: new Date().toISOString(),
      tool: 'scripts/harvest-keynote-pdf.ts',
      manuallyEditedPdfArtifact: sourceKind === 'edited-pdf',
      export: sourceExportMetadata,
    },
    harvestedAt: new Date().toISOString(),
    slideCount: harvestedPages,
    slideDimensions: { width: info.width, height: info.height, aspectRatio: info.aspectRatio },
    slides: slidesWithAssets,
    assets,
    warnings,
  };

  assertWithinBudget('manifest writing');
  recordPhase('Writing manifest');
  validateKeynoteHarvestManifest(manifest);
  const stagedManifestPath = path.join(stagingDir, 'keynote-harvest-manifest.json');
  writeFileSync(stagedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  writeFileSync(
    path.join(stagingDir, 'README.md'),
    [
      `# ${args.title} Harvest`,
      '',
      `Source PDF: ${path.basename(pdfPath)}`,
      `Slides: ${manifest.slideCount}`,
      `Previews: ${readdirSync(previewsDir).length}`,
      `Text files: ${readdirSync(textDir).length}`,
      `Extracted assets: ${assets.length}`,
      '',
      'This local PDF-first harvest can be inspected directly or through the Keynote Harvest MCP server.',
      '',
    ].join('\n')
  );
  assertOutputWithinLimit(stagingDir);
  recordPhase('Replacing outputs');
  replaceManagedOutputs(outDir, stagingDir, [
    'previews',
    'text',
    'assets',
    'keynote-harvest-manifest.json',
    'README.md',
  ]);

  recordJob({ status: 'completed', finishedAt: new Date().toISOString(), message: `Harvested ${manifest.slideCount} slide(s)` });
  console.log(`Wrote ${path.join(outDir, 'keynote-harvest-manifest.json')}`);
  console.log(`Slides: ${manifest.slideCount}`);
  console.log(`Warnings: ${manifest.warnings?.length ?? 0}`);
  } finally {
    removeSignalCleanup();
    rmSync(stagingDir, { recursive: true, force: true });
  }
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
