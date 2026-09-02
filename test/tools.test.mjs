import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cliPath } from '../dist/lib/paths.js';
import { exportKeynoteToPdf } from '../dist/tools/exportKeynoteToPdf.js';
import { harvestKeynotePdf } from '../dist/tools/harvestKeynotePdf.js';
import { listHarvests } from '../dist/tools/listHarvests.js';
import { listKeynoteApps } from '../dist/tools/listKeynoteApps.js';
import { readManifest } from '../dist/tools/readManifest.js';

test('compiled tool runtime resolves compiled CLI files', () => {
  assert.match(cliPath('harvest-keynote-pdf.js'), /dist\/cli\/harvest-keynote-pdf\.js$/);
});

test('Keynote app discovery hides local app paths unless the operator enables debug output', async (t) => {
  const previous = process.env.KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG;
  t.after(() => {
    if (previous === undefined) delete process.env.KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG;
    else process.env.KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG = previous;
  });
  delete process.env.KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG;
  const display = await listKeynoteApps({ searchApplicationsDir: false });
  assert.ok(display.candidates.every((candidate) => candidate.path === undefined));
  await assert.rejects(
    listKeynoteApps({ searchApplicationsDir: false, redactionMode: 'local-debug' }),
    /operator authorization/
  );
  process.env.KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG = '1';
  const debug = await listKeynoteApps({ searchApplicationsDir: false, redactionMode: 'local-debug' });
  assert.ok(debug.localDebug.candidates.every((candidate) => typeof candidate.path === 'string'));
});

test('harvest listing is display-safe by default and explicit in local-debug mode', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-harvest-list-'));
  const previousRoot = process.env.KEYNOTE_HARVEST_ROOT;
  const previousDebug = process.env.KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG;
  try {
    process.env.KEYNOTE_HARVEST_ROOT = root;
    const outputDirectory = path.join(root, 'sample-deck');
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, 'keynote-harvest-manifest.json'), '{}');

    const display = await listHarvests({});
    assert.equal(display.harvestRoot, undefined);
    assert.equal(display.outputs[0].outputDirectory, undefined);
    assert.equal(display.outputs[0].outputRelativePath, 'sample-deck');

    await assert.rejects(listHarvests({ redactionMode: 'local-debug' }), /operator authorization/);
    process.env.KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG = '1';
    const localDebug = await listHarvests({ redactionMode: 'local-debug' });
    assert.equal(localDebug.harvestRoot, root);
    assert.equal(localDebug.outputs[0].outputDirectory, outputDirectory);
  } finally {
    if (previousRoot === undefined) delete process.env.KEYNOTE_HARVEST_ROOT;
    else process.env.KEYNOTE_HARVEST_ROOT = previousRoot;
    if (previousDebug === undefined) delete process.env.KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG;
    else process.env.KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG = previousDebug;
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest reads are slug-scoped, validated, and operator-gated for local paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-harvest-manifest-'));
  const previousRoot = process.env.KEYNOTE_HARVEST_ROOT;
  const previousDebug = process.env.KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG;
  try {
    process.env.KEYNOTE_HARVEST_ROOT = root;
    const manifestPath = path.join(root, 'sample-deck', 'keynote-harvest-manifest.json');
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 'keynote-harvest-manifest-v1',
      id: 'harvest-sample-deck',
      deckTitle: 'Sample',
      harvestedAt: '2026-01-01T00:00:00.000Z',
      slideCount: 1,
      slideDimensions: { width: 1600, height: 900, aspectRatio: '16:9' },
      slides: [{
        id: 'slide-001',
        index: 1,
        dimensions: { width: 1600, height: 900, aspectRatio: '16:9' },
        textRuns: [],
        assetIds: [],
      }],
      assets: [],
      source: {
        id: 'source-sample-deck-keynote',
        kind: 'keynote',
        displayName: 'Sample.key',
        sourceFilePath: '/Users/example/private/Sample.key',
        harvestedAt: '2026-01-01T00:00:00.000Z',
        tool: 'test',
      },
    }));

    const display = await readManifest({ slug: 'sample-deck' });
    assert.equal(display.source.sourceFilePath, undefined);
    assert.equal(display.source.sourceDisplayName, 'Sample.key');
    assert.equal(display.manifestHarvestPath, 'sample-deck/keynote-harvest-manifest.json');

    await assert.rejects(readManifest({ slug: 'sample-deck', redactionMode: 'local-debug' }), /operator authorization/);
    process.env.KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG = '1';
    const localDebug = await readManifest({ slug: 'sample-deck', redactionMode: 'local-debug' });
    assert.equal(localDebug.localDebug.source.sourceFilePath, '/Users/example/private/Sample.key');
    await assert.rejects(readManifest({ manifestPath }), /Unrecognized key/);
    await writeFile(manifestPath, '{}');
    await assert.rejects(readManifest({ slug: 'sample-deck' }), /Invalid KeynoteHarvestManifest/);
  } finally {
    if (previousRoot === undefined) delete process.env.KEYNOTE_HARVEST_ROOT;
    else process.env.KEYNOTE_HARVEST_ROOT = previousRoot;
    if (previousDebug === undefined) delete process.env.KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG;
    else process.env.KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG = previousDebug;
    await rm(root, { recursive: true, force: true });
  }
});

test('Keynote export failure is display-safe by default and explicit in local-debug mode', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-harvest-export-'));
  const previousRoot = process.env.KEYNOTE_HARVEST_ROOT;
  const previousDebug = process.env.KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG;
  process.env.KEYNOTE_HARVEST_ROOT = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.KEYNOTE_HARVEST_ROOT;
    else process.env.KEYNOTE_HARVEST_ROOT = previousRoot;
    if (previousDebug === undefined) delete process.env.KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG;
    else process.env.KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG = previousDebug;
  });
  const keynotePath = path.join(root, 'Missing Private Deck.key');
  const outPath = path.join(root, 'missing-private-deck', 'source', 'missing-private-deck.pdf');
  try {
    await assert.rejects(
      exportKeynoteToPdf({
        keynotePath,
        outPath,
        slug: 'missing-private-deck',
        keynoteAppPath: path.join(root, 'Spoofed Keynote.app'),
      }),
      /outside the operator-configured application roots/
    );

    const display = await exportKeynoteToPdf({
      keynotePath,
      outPath,
      slug: 'missing-private-deck',
    });
    assert.equal(display.success, false);
    assert.equal(display.sourceKeynotePath, undefined);
    assert.equal(display.localDebug, undefined);
    assert.equal(display.exportedPdfPath, undefined);
    assert.equal(display.exportedPdfHarvestPath, 'missing-private-deck/source/missing-private-deck.pdf');
    assert.doesNotMatch(display.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    await assert.rejects(exportKeynoteToPdf({
      keynotePath,
      outPath,
      slug: 'missing-private-deck',
      redactionMode: 'local-debug',
    }), /operator authorization/);
    process.env.KEYNOTE_HARVEST_ALLOW_LOCAL_DEBUG = '1';
    const localDebug = await exportKeynoteToPdf({ keynotePath, outPath, slug: 'missing-private-deck', redactionMode: 'local-debug' });
    assert.equal(localDebug.localDebug.sourceKeynoteLocalPath, keynotePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('output paths are contained to the harvest root unless the operator opts in via environment', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-harvest-containment-'));
  const previousRoot = process.env.KEYNOTE_HARVEST_ROOT;
  const previousInputs = process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS;
  process.env.KEYNOTE_HARVEST_ROOT = path.join(root, 'harvests');
  process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.KEYNOTE_HARVEST_ROOT;
    else process.env.KEYNOTE_HARVEST_ROOT = previousRoot;
    if (previousInputs === undefined) delete process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS;
    else process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS = previousInputs;
  });

  try {
    const outsidePdf = path.join(root, 'outside', 'escape.pdf');
    await assert.rejects(
      exportKeynoteToPdf({
        keynotePath: path.join(root, 'Missing Deck.key'),
        outPath: outsidePdf,
        slug: 'escape',
      }),
      /outside the harvest root/
    );
    await assert.rejects(
      harvestKeynotePdf({
        pdfPath: path.join(root, 'missing.pdf'),
        slug: 'escape',
        title: 'Escape',
        outDir: path.join(root, 'outside'),
      }),
      /outside the harvest root/
    );

    // The escape argument alone is not sufficient: without the operator env
    // opt-in a calling agent cannot set it itself to escape containment.
    await assert.rejects(
      exportKeynoteToPdf({
        keynotePath: path.join(root, 'Missing Deck.key'),
        outPath: outsidePdf,
        slug: 'escape',
        allowOutsideHarvestRoot: true,
      }),
      /operator authorization/
    );
    await assert.rejects(
      harvestKeynotePdf({
        pdfPath: path.join(root, 'missing.pdf'),
        slug: 'escape',
        title: 'Escape',
        outDir: path.join(root, 'outside'),
        allowOutsideHarvestRoot: true,
      }),
      /operator authorization/
    );

    // With the operator env opt-in the outside-root write is permitted (this
    // export still fails on the missing .key, but no longer on containment).
    process.env.KEYNOTE_HARVEST_ALLOW_OUTSIDE_ROOT = '1';
    try {
      const allowed = await exportKeynoteToPdf({
        keynotePath: path.join(root, 'Missing Deck.key'),
        outPath: outsidePdf,
        slug: 'escape',
        allowOutsideHarvestRoot: true,
      });
      assert.equal(allowed.success, false);
      assert.doesNotMatch(allowed.message, /outside the harvest root/);
      assert.doesNotMatch(allowed.message, /operator authorization/);
    } finally {
      delete process.env.KEYNOTE_HARVEST_ALLOW_OUTSIDE_ROOT;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('output containment rejects symbolic-link escapes from the harvest root', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-harvest-containment-link-'));
  const harvestsDir = path.join(root, 'harvests');
  const previousRoot = process.env.KEYNOTE_HARVEST_ROOT;
  const previousInputs = process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS;
  process.env.KEYNOTE_HARVEST_ROOT = harvestsDir;
  process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.KEYNOTE_HARVEST_ROOT;
    else process.env.KEYNOTE_HARVEST_ROOT = previousRoot;
    if (previousInputs === undefined) delete process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS;
    else process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS = previousInputs;
  });

  try {
    await mkdir(harvestsDir, { recursive: true });
    await mkdir(path.join(root, 'outside'), { recursive: true });
    await symlink(path.join(root, 'outside'), path.join(harvestsDir, 'escape-link'));

    await assert.rejects(
      exportKeynoteToPdf({
        keynotePath: path.join(root, 'Missing Deck.key'),
        outPath: path.join(harvestsDir, 'escape-link', 'escape.pdf'),
        slug: 'escape',
      }),
      /outside the harvest root/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default output paths are contained when the harvest slug directory is a symlink', async (t) => {
  // Regression: with no explicit outDir/outPath the resolved default path is
  // <harvestRoot>/<slug>. If that entry is a symlink pointing outside the root,
  // containment must still reject it — the escape must not depend on the caller
  // supplying an outDir/outPath.
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-harvest-default-link-'));
  const harvestsDir = path.join(root, 'harvests');
  const previousRoot = process.env.KEYNOTE_HARVEST_ROOT;
  const previousInputs = process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS;
  process.env.KEYNOTE_HARVEST_ROOT = harvestsDir;
  process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.KEYNOTE_HARVEST_ROOT;
    else process.env.KEYNOTE_HARVEST_ROOT = previousRoot;
    if (previousInputs === undefined) delete process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS;
    else process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS = previousInputs;
  });

  try {
    await mkdir(harvestsDir, { recursive: true });
    await mkdir(path.join(root, 'outside'), { recursive: true });
    await symlink(path.join(root, 'outside'), path.join(harvestsDir, 'escaped'));

    // No outDir / outPath supplied: the default path resolves through the symlink.
    await assert.rejects(
      harvestKeynotePdf({
        pdfPath: path.join(root, 'missing.pdf'),
        slug: 'escaped',
        title: 'Escape',
      }),
      /outside the harvest root/
    );
    await assert.rejects(
      exportKeynoteToPdf({
        keynotePath: path.join(root, 'Missing Deck.key'),
        slug: 'escaped',
      }),
      /outside the harvest root/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
