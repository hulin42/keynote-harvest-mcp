import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { harvestKeynotePdf } from '../dist/tools/harvestKeynotePdf.js';
import { readManifest } from '../dist/tools/readManifest.js';
import { validateKeynoteHarvestManifest } from '../dist/schema/validateManifest.js';
import { CURRENT_KEYNOTE_HARVEST_MANIFEST_VERSION } from '../dist/schema/version.js';

function createSyntheticPdf(pageCount = 1, pageSizes = []) {
  const fontId = 3 + pageCount * 2;
  const kids = Array.from({ length: pageCount }, (unused, index) => `${3 + index * 2} 0 R`);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`,
  ];
  for (let index = 0; index < pageCount; index += 1) {
    const [pageWidth, pageHeight] = pageSizes[index] ?? [612, 792];
    const text = index === 0 ? 'Synthetic Keynote harvest' : `Synthetic page ${index + 1}`;
    const stream = `BT\n/F1 24 Tf\n72 72 Td\n(${text}) Tj\nET\n`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}endstream`
    );
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}

// Like createSyntheticPdf, but each page draws one embedded 2x2 RGB image so
// pdfimages has assets to list and extract.
function createSyntheticPdfWithImages(pageCount) {
  const fontId = 2 + pageCount * 3 + 1;
  const kids = Array.from({ length: pageCount }, (unused, index) => `${3 + index * 3} 0 R`);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`,
  ];
  const imagePixels = '\xff\x00\x00\x00\xff\x00\x00\x00\xff\xff\xff\x00';
  for (let index = 0; index < pageCount; index += 1) {
    const imageId = 5 + index * 3;
    const stream = `BT\n/F1 24 Tf\n72 720 Td\n(Image page ${index + 1}) Tj\nET\nq\n144 0 0 144 200 400 cm\n/Im1 Do\nQ\n`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> /XObject << /Im1 ${imageId} 0 R >> >> /Contents ${4 + index * 3} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
      `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${imagePixels.length} >>\nstream\n${imagePixels}\nendstream`
    );
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'keynote-harvest-pdf-runtime-'));
// Output containment is on by default; point the harvest root at the rehearsal directory.
process.env.KEYNOTE_HARVEST_ROOT = temporaryRoot;

try {
  const pdfPath = path.join(temporaryRoot, 'synthetic-deck.pdf');
  const outputDirectory = path.join(temporaryRoot, 'synthetic-pdf-runtime');
  await writeFile(pdfPath, createSyntheticPdf(), 'ascii');

  const result = await harvestKeynotePdf({
    pdfPath,
    slug: 'synthetic-pdf-runtime',
    title: 'Synthetic PDF Runtime',
    outDir: outputDirectory,
  });
  const manifest = JSON.parse(await readFile(path.join(outputDirectory, 'keynote-harvest-manifest.json'), 'utf8'));
  validateKeynoteHarvestManifest(manifest);

  assert.equal(result.manifestPath, undefined);
  assert.equal(result.outputDirectory, undefined);
  assert.equal(result.manifestHarvestPath, 'synthetic-pdf-runtime/keynote-harvest-manifest.json');
  assert.equal(result.slideCount, 1);
  assert.equal(result.previewCount, 1);
  assert.ok(result.extractedTextRunCount >= 1);
  assert.equal(manifest.schemaVersion, CURRENT_KEYNOTE_HARVEST_MANIFEST_VERSION);
  assert.equal(manifest.slides[0].textRuns[0].text, 'Synthetic Keynote harvest');
  assert.equal(manifest.source.sourceFilePath, undefined);
  assert.equal(manifest.source.export?.sourcePath, undefined);
  assert.equal(manifest.source.export?.exportedPdfPath, undefined);
  assert.equal(manifest.source.export?.selectedKeynoteAppPath, undefined);
  // Extraction now defaults on: the image-free synthetic deck yields zero assets
  // and must not carry the extraction-skipped warning.
  assert.equal(result.assetCount, 0);
  assert.ok(!manifest.warnings.some((warning) => warning.id === 'warning-embedded-images-not-extracted'));

  const exportedSourceDirectory = path.join(temporaryRoot, 'synthetic-exported', 'source');
  await mkdir(exportedSourceDirectory, { recursive: true });
  await copyFile(pdfPath, path.join(exportedSourceDirectory, 'synthetic-exported.pdf'));
  const harvestRelative = await harvestKeynotePdf({
    harvestPdfPath: 'synthetic-exported/source/synthetic-exported.pdf',
    slug: 'synthetic-exported',
    title: 'Synthetic Exported',
  });
  assert.equal(harvestRelative.slideCount, 1);
  assert.equal(harvestRelative.outputHarvestPath, 'synthetic-exported');

  const multiPagePdfPath = path.join(temporaryRoot, 'synthetic-multi.pdf');
  await writeFile(multiPagePdfPath, createSyntheticPdf(3), 'ascii');

  const full = await harvestKeynotePdf({
    pdfPath: multiPagePdfPath,
    slug: 'synthetic-multi-full',
    title: 'Synthetic Multi Full',
    outDir: path.join(temporaryRoot, 'synthetic-multi-full'),
  });
  assert.equal(full.slideCount, 3);
  assert.ok(!full.warnings.some((warning) => warning.id === 'warning-max-pages-truncated'));

  const truncated = await harvestKeynotePdf({
    pdfPath: multiPagePdfPath,
    slug: 'synthetic-multi-truncated',
    title: 'Synthetic Multi Truncated',
    outDir: path.join(temporaryRoot, 'synthetic-multi-truncated'),
    maxPages: 2,
  });
  const truncatedManifest = JSON.parse(
    await readFile(path.join(temporaryRoot, 'synthetic-multi-truncated', 'keynote-harvest-manifest.json'), 'utf8')
  );
  validateKeynoteHarvestManifest(truncatedManifest);
  assert.equal(truncated.slideCount, 2);
  assert.equal(truncatedManifest.slides.length, 2);
  assert.ok(truncated.warnings.some((warning) => warning.id === 'warning-max-pages-truncated'));

  // Regression: re-harvesting into an existing directory must not leave stale
  // slides, text, or assets from a longer previous deck readable alongside the
  // new manifest.
  const reuseDir = path.join(temporaryRoot, 'synthetic-reuse');
  await harvestKeynotePdf({
    pdfPath: multiPagePdfPath,
    slug: 'synthetic-reuse',
    title: 'Synthetic Reuse First',
    outDir: reuseDir,
  });
  const previewsAfterThree = (await readdir(path.join(reuseDir, 'previews'))).filter((name) => name.endsWith('.png'));
  assert.equal(previewsAfterThree.length, 3);

  const singlePagePdfPath = path.join(temporaryRoot, 'synthetic-single.pdf');
  await writeFile(singlePagePdfPath, createSyntheticPdf(1), 'ascii');
  const reharvested = await harvestKeynotePdf({
    pdfPath: singlePagePdfPath,
    slug: 'synthetic-reuse',
    title: 'Synthetic Reuse Second',
    outDir: reuseDir,
  });
  assert.equal(reharvested.slideCount, 1);
  const previewsAfterOne = (await readdir(path.join(reuseDir, 'previews'))).filter((name) => name.endsWith('.png')).sort();
  const textAfterOne = (await readdir(path.join(reuseDir, 'text'))).filter((name) => name.endsWith('.txt')).sort();
  assert.deepEqual(previewsAfterOne, ['slide-001.png']);
  assert.deepEqual(textAfterOne, ['slide-001.txt']);

  const preservedManifest = await readFile(path.join(reuseDir, 'keynote-harvest-manifest.json'), 'utf8');
  const invalidPdfPath = path.join(temporaryRoot, 'invalid.pdf');
  await writeFile(invalidPdfPath, 'not a pdf\n');
  await assert.rejects(
    harvestKeynotePdf({
      pdfPath: invalidPdfPath,
      slug: 'synthetic-reuse',
      title: 'Invalid Replacement',
    })
  );
  assert.equal(await readFile(path.join(reuseDir, 'keynote-harvest-manifest.json'), 'utf8'), preservedManifest);
  assert.deepEqual(
    (await readdir(path.join(reuseDir, 'previews'))).filter((name) => name.endsWith('.png')),
    ['slide-001.png']
  );

  process.env.KEYNOTE_HARVEST_MAX_OUTPUT_BYTES = '100';
  try {
    await assert.rejects(
      harvestKeynotePdf({
        pdfPath: singlePagePdfPath,
        slug: 'synthetic-reuse',
        title: 'Quota Failure',
      }),
      /output limit/
    );
  } finally {
    delete process.env.KEYNOTE_HARVEST_MAX_OUTPUT_BYTES;
  }
  assert.equal(await readFile(path.join(reuseDir, 'keynote-harvest-manifest.json'), 'utf8'), preservedManifest);

  // Regression: --max-pages must bound embedded-image extraction, not just
  // previews and text.
  const imagePdfPath = path.join(temporaryRoot, 'synthetic-images.pdf');
  await writeFile(imagePdfPath, createSyntheticPdfWithImages(2), 'latin1');
  const imagesFull = await harvestKeynotePdf({
    pdfPath: imagePdfPath,
    slug: 'synthetic-images-full',
    title: 'Synthetic Images Full',
    outDir: path.join(temporaryRoot, 'synthetic-images-full'),
  });
  assert.equal(imagesFull.slideCount, 2);
  assert.equal(imagesFull.assetCount, 2);

  const imagesTruncated = await harvestKeynotePdf({
    pdfPath: imagePdfPath,
    slug: 'synthetic-images-truncated',
    title: 'Synthetic Images Truncated',
    outDir: path.join(temporaryRoot, 'synthetic-images-truncated'),
    maxPages: 1,
  });
  assert.equal(imagesTruncated.slideCount, 1);
  assert.equal(imagesTruncated.assetCount, 1);
  const truncatedImagesManifest = JSON.parse(
    await readFile(path.join(temporaryRoot, 'synthetic-images-truncated', 'keynote-harvest-manifest.json'), 'utf8')
  );
  assert.ok(
    truncatedImagesManifest.assets.every((asset) => asset.sourceSlideId === 'slide-001'),
    'truncated harvests must not extract images from unharvested pages'
  );
  const truncatedAssetFiles = await readdir(path.join(temporaryRoot, 'synthetic-images-truncated', 'assets'));
  assert.equal(truncatedAssetFiles.filter((name) => name.endsWith('.png')).length, 1);

  // Regression: preview rendering must respect the pixel budget before
  // Poppler runs — clamping DPI with a warning, or refusing below minimum DPI.
  process.env.KEYNOTE_HARVEST_MAX_PREVIEW_PIXELS = '500000';
  try {
    const clamped = await harvestKeynotePdf({
      pdfPath: singlePagePdfPath,
      slug: 'synthetic-clamped',
      title: 'Synthetic Clamped',
      outDir: path.join(temporaryRoot, 'synthetic-clamped'),
    });
    assert.equal(clamped.slideCount, 1);
    assert.ok(clamped.warnings.some((warning) => warning.id === 'warning-preview-dpi-clamped'));

    process.env.KEYNOTE_HARVEST_MAX_PREVIEW_PIXELS = '1000';
    await assert.rejects(
      harvestKeynotePdf({
        pdfPath: singlePagePdfPath,
        slug: 'synthetic-over-budget',
        title: 'Synthetic Over Budget',
        outDir: path.join(temporaryRoot, 'synthetic-over-budget'),
      }),
      /preview render budget/
    );

    // Regression: the budget must use each page's own dimensions — a small
    // first page must not let an oversized later page render past the limit.
    const mixedPdfPath = path.join(temporaryRoot, 'synthetic-mixed.pdf');
    await writeFile(mixedPdfPath, createSyntheticPdf(2, [[612, 792], [2448, 3168]]), 'ascii');
    process.env.KEYNOTE_HARVEST_MAX_PREVIEW_PIXELS = '2000000';
    const mixed = await harvestKeynotePdf({
      pdfPath: mixedPdfPath,
      slug: 'synthetic-mixed',
      title: 'Synthetic Mixed',
      outDir: path.join(temporaryRoot, 'synthetic-mixed'),
    });
    assert.equal(mixed.slideCount, 2);
    const mixedWarning = mixed.warnings.find((warning) => warning.id === 'warning-preview-dpi-clamped');
    assert.ok(mixedWarning, 'the oversized page must clamp');
    assert.match(mixedWarning.message, /\(2\)/, 'only page 2 should clamp');
    const secondPreview = await readFile(path.join(temporaryRoot, 'synthetic-mixed', 'previews', 'slide-002.png'));
    const renderedPixels = secondPreview.readUInt32BE(16) * secondPreview.readUInt32BE(20);
    assert.ok(
      renderedPixels <= 2_000_000,
      `page 2 rendered ${renderedPixels} pixels, over the 2,000,000-pixel budget`
    );
    const mixedManifest = JSON.parse(
      await readFile(path.join(temporaryRoot, 'synthetic-mixed', 'keynote-harvest-manifest.json'), 'utf8')
    );
    assert.equal(mixedManifest.slides[1].dimensions.width, 2448);
  } finally {
    delete process.env.KEYNOTE_HARVEST_MAX_PREVIEW_PIXELS;
  }

  // Regression: a long multi-page harvest driven over real MCP stdio must
  // survive a host request timeout far shorter than the harvest, because the
  // server now streams progress notifications (the 2026-08-31 dogfood found
  // the SDK's default 60s timeout killing a 56-page harvest).
  const progressPdfPath = path.join(temporaryRoot, 'progress-regression', 'source', 'deck.pdf');
  await mkdir(path.dirname(progressPdfPath), { recursive: true });
  await writeFile(progressPdfPath, createSyntheticPdf(40), 'ascii');

  const serverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      PATH: process.env.PATH ?? '',
      KEYNOTE_HARVEST_ROOT: temporaryRoot,
    },
  });
  const client = new Client({ name: 'progress-regression', version: '0.0.0' });
  await client.connect(transport);
  try {
    const progressEvents = [];
    const startedAt = process.hrtime.bigint();
    const result = await client.callTool(
      {
        name: 'harvest_keynote_pdf',
        arguments: {
          harvestPdfPath: 'progress-regression/source/deck.pdf',
          slug: 'progress-regression',
          title: 'Progress Regression',
        },
      },
      undefined,
      {
        timeout: 1500,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: 600_000,
        onprogress: (progress) => progressEvents.push(progress),
      }
    );
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    assert.ok(!result.isError, `harvest over MCP failed: ${JSON.stringify(result.content)}`);
    assert.ok(
      elapsedMs > 1500,
      `harvest finished in ${Math.round(elapsedMs)}ms; grow the synthetic deck so the run exceeds the 1500ms request timeout`
    );
    assert.ok(
      progressEvents.length >= 10,
      `expected a stream of progress notifications, saw ${progressEvents.length}`
    );
    assert.ok(
      progressEvents.some((event) => event.total === 40 && event.progress === 40),
      'the final page progress event must report 40/40'
    );
    for (let i = 1; i < progressEvents.length; i += 1) {
      assert.ok(
        progressEvents[i].progress > progressEvents[i - 1].progress,
        'progress must increase monotonically'
      );
    }
  } finally {
    await client.close();
  }

  // Regression: runInBackground must return at once and the detached worker
  // must land a complete, valid harvest that get_harvest_manifest reports
  // as running (with page progress) and then as the manifest — the path for
  // hosts that cap tool-call duration (Claude Desktop's ~4 minute limit).
  const backgroundPdfPath = path.join(temporaryRoot, 'background-job', 'source', 'deck.pdf');
  await mkdir(path.dirname(backgroundPdfPath), { recursive: true });
  await writeFile(backgroundPdfPath, createSyntheticPdf(40), 'ascii');
  const launchStarted = process.hrtime.bigint();
  const launched = await harvestKeynotePdf({
    harvestPdfPath: 'background-job/source/deck.pdf',
    slug: 'background-job',
    title: 'Background Job',
    runInBackground: true,
  });
  const launchMs = Number(process.hrtime.bigint() - launchStarted) / 1e6;
  assert.equal(launched.status, 'running');
  assert.ok(launchMs < 2000, `background launch must return immediately, took ${launchMs}ms`);

  let sawProgress = false;
  const messagesSeen = new Set();
  let finalStatus;
  const deadline = Date.now() + 120_000;
  for (;;) {
    finalStatus = await readManifest({ slug: 'background-job' });
    if (finalStatus.status === 'running') {
      if (finalStatus.job?.progress?.page > 0) sawProgress = true;
      if (finalStatus.job?.message) messagesSeen.add(finalStatus.job.message);
      assert.ok(Date.now() < deadline, 'background harvest did not finish within 120s');
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    break;
  }
  assert.ok(sawProgress, 'polling must observe page progress while the job runs');
  // Finalization phases are recorded durably in the job record, so a poller
  // can always tell "finalizing" from "stalled" even after the fact.
  assert.ok(Array.isArray(finalStatus.job.phases), 'completed job must carry its phases');
  for (const phase of ['Rendering pages', 'Writing manifest', 'Replacing outputs']) {
    assert.ok(finalStatus.job.phases.includes(phase), `missing phase "${phase}" in ${JSON.stringify(finalStatus.job.phases)}`);
  }
  void messagesSeen;
  assert.equal(finalStatus.slideCount, 40);
  assert.equal(finalStatus.job.status, 'completed');
  assert.ok(finalStatus.job.finishedAt);

  // Regression: a detached worker must enforce the total command budget
  // itself (it is not under runCommand's process-group timeout).
  const budgetPdfPath = path.join(temporaryRoot, 'budget-job', 'source', 'deck.pdf');
  await mkdir(path.dirname(budgetPdfPath), { recursive: true });
  await writeFile(budgetPdfPath, createSyntheticPdf(40), 'ascii');
  process.env.KEYNOTE_HARVEST_COMMAND_TIMEOUT_MS = '1500';
  const budgetStarted = process.hrtime.bigint();
  try {
    const launched = await harvestKeynotePdf({
      harvestPdfPath: 'budget-job/source/deck.pdf',
      slug: 'budget-job',
      title: 'Budget Job',
      runInBackground: true,
    });
    assert.equal(launched.status, 'running');
    let outcome;
    const budgetDeadline = Date.now() + 60_000;
    for (;;) {
      try {
        outcome = await readManifest({ slug: 'budget-job' });
      } catch (error) {
        outcome = { failedWith: error.message };
      }
      if (outcome.status !== 'running') break;
      assert.ok(Date.now() < budgetDeadline, 'budget-limited worker did not stop');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(outcome.failedWith, `expected the over-budget job to fail, got ${JSON.stringify(outcome)}`);
    assert.match(outcome.failedWith, /total budget/);
    // Each Poppler call is capped by the remaining budget, so the worker stops
    // within roughly one step of the deadline, not one full Poppler timeout.
    const budgetElapsedMs = Number(process.hrtime.bigint() - budgetStarted) / 1e6;
    assert.ok(budgetElapsedMs < 1500 + 3000, `over-budget worker took ${Math.round(budgetElapsedMs)}ms to stop`);
  } finally {
    delete process.env.KEYNOTE_HARVEST_COMMAND_TIMEOUT_MS;
  }

  console.log('Synthetic PDF runtime rehearsal passed.');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
