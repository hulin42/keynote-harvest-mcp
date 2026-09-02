import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listHarvestResources, readHarvestResource } from '../dist/lib/resources.js';

async function withHarvestRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-harvest-resources-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('reads a contained text resource', async () => {
  await withHarvestRoot(async (root) => {
    const textDir = path.join(root, 'sample-deck', 'text');
    await mkdir(textDir, { recursive: true });
    await writeFile(path.join(textDir, 'slide-001.txt'), 'Hello from slide one.\n');

    const result = await readHarvestResource('keynote-harvest://sample-deck/text/slide-001.txt', root);
    assert.equal(result.contents[0].text, 'Hello from slide one.\n');
  });
});

test('rejects slug and relative-path traversal', async () => {
  await withHarvestRoot(async (root) => {
    await assert.rejects(
      readHarvestResource('keynote-harvest://../package.json', root),
      /Invalid harvest slug/
    );
    await assert.rejects(
      readHarvestResource('keynote-harvest://sample-deck/../outside.txt', root),
      /Invalid harvest resource path/
    );
  });
});

test('rejects symbolic-link escapes', async () => {
  await withHarvestRoot(async (root) => {
    const textDir = path.join(root, 'sample-deck', 'text');
    const outsidePath = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
    await mkdir(textDir, { recursive: true });
    await writeFile(outsidePath, 'outside\n');
    await symlink(outsidePath, path.join(textDir, 'escape.txt'));

    try {
      await assert.rejects(
        readHarvestResource('keynote-harvest://sample-deck/text/escape.txt', root),
        /symbolic link/
      );
    } finally {
      await rm(outsidePath, { force: true });
    }
  });
});

test('redacts local paths from JSON resources', async () => {
  await withHarvestRoot(async (root) => {
    const deckDir = path.join(root, 'sample-deck');
    await mkdir(deckDir, { recursive: true });
    await writeFile(
      path.join(deckDir, 'keynote-harvest-manifest.json'),
      JSON.stringify({
        id: 'sample',
        source: {
          displayName: 'Sample.key',
          sourceFilePath: '/Users/example/private/Sample.key',
          export: {
            exportedPdfPath: '/Users/example/private/Sample.pdf',
            selectedKeynoteAppPath: '/Applications/Keynote.app',
            redactedExportedPdfFileName: 'Sample.pdf',
          },
        },
        warnings: [{ message: 'Failed at /Users/example/private/Sample.key' }],
      })
    );

    const result = await readHarvestResource(
      'keynote-harvest://sample-deck/keynote-harvest-manifest.json',
      root
    );
    const manifest = JSON.parse(result.contents[0].text);
    assert.equal(manifest.source.displayName, 'Sample.key');
    assert.equal(manifest.source.sourceFilePath, undefined);
    assert.equal(manifest.source.export.exportedPdfPath, undefined);
    assert.equal(manifest.source.export.selectedKeynoteAppPath, undefined);
    assert.equal(manifest.source.export.redactedExportedPdfFileName, 'Sample.pdf');
    assert.doesNotMatch(manifest.warnings[0].message, /\/Users\/example\/private/);
  });
});

test('lists extracted assets alongside previews and reads them as binary blobs', async () => {
  await withHarvestRoot(async (root) => {
    const deckDir = path.join(root, 'sample-deck');
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await mkdir(path.join(deckDir, 'previews'), { recursive: true });
    await mkdir(path.join(deckDir, 'assets'), { recursive: true });
    await writeFile(path.join(deckDir, 'keynote-harvest-manifest.json'), '{}');
    await writeFile(path.join(deckDir, 'previews', 'slide-001.png'), pngBytes);
    await writeFile(path.join(deckDir, 'assets', 'slide-001-asset-000.png'), pngBytes);

    const resources = await listHarvestResources(root);
    assert.deepEqual(resources.map((resource) => resource.uri), [
      'keynote-harvest://sample-deck/keynote-harvest-manifest.json',
      'keynote-harvest://sample-deck/previews/slide-001.png',
      'keynote-harvest://sample-deck/assets/slide-001-asset-000.png',
    ]);
    const asset = resources.find((resource) => resource.uri.includes('/assets/'));
    assert.equal(asset.mimeType, 'image/png');

    const read = await readHarvestResource(asset.uri, root);
    assert.equal(read.contents[0].blob, pngBytes.toString('base64'));
    assert.equal(read.contents[0].mimeType, 'image/png');
  });
});

test('source PDFs are denied by default and require an operator opt-in for listing and reading', async (t) => {
  const previous = process.env.KEYNOTE_HARVEST_ALLOW_SOURCE_RESOURCES;
  t.after(() => {
    if (previous === undefined) delete process.env.KEYNOTE_HARVEST_ALLOW_SOURCE_RESOURCES;
    else process.env.KEYNOTE_HARVEST_ALLOW_SOURCE_RESOURCES = previous;
  });
  delete process.env.KEYNOTE_HARVEST_ALLOW_SOURCE_RESOURCES;

  await withHarvestRoot(async (root) => {
    const deckDir = path.join(root, 'sample-deck');
    await mkdir(path.join(deckDir, 'source'), { recursive: true });
    await writeFile(path.join(deckDir, 'keynote-harvest-manifest.json'), '{}');
    await writeFile(path.join(deckDir, 'source', 'sample-deck.pdf'), '%PDF-1.4\n');
    await writeFile(
      path.join(deckDir, 'source', 'export-summary.json'),
      JSON.stringify({
        exportedPdfPath: '/Users/example/private/sample-deck.pdf',
        warning: 'Failed at /Users/example/private/sample-deck.pdf',
      })
    );

    const defaultListing = await listHarvestResources(root);
    assert.ok(!defaultListing.some((resource) => resource.uri.includes('/source/')));

    await assert.rejects(
      readHarvestResource('keynote-harvest://sample-deck/source/sample-deck.pdf', root),
      /not exposed by policy/
    );

    process.env.KEYNOTE_HARVEST_ALLOW_SOURCE_RESOURCES = '1';
    const read = await readHarvestResource('keynote-harvest://sample-deck/source/sample-deck.pdf', root);
    assert.equal(read.contents[0].mimeType, 'application/pdf');
    assert.ok(read.contents[0].blob.length > 0);
    const summaryRead = await readHarvestResource(
      'keynote-harvest://sample-deck/source/export-summary.json',
      root
    );
    const summary = JSON.parse(summaryRead.contents[0].text);
    assert.equal(summary.exportedPdfPath, undefined);
    assert.doesNotMatch(summary.warning, /\/Users\/example\/private/);

    const optInListing = await listHarvestResources(root);
    assert.ok(
      optInListing.some((resource) => resource.uri === 'keynote-harvest://sample-deck/source/sample-deck.pdf')
    );
  });
});

test('resource reads reject unlisted files even when they are contained under a harvest slug', async () => {
  await withHarvestRoot(async (root) => {
    const deckDir = path.join(root, 'sample-deck');
    await mkdir(deckDir, { recursive: true });
    await writeFile(path.join(deckDir, 'private-notes.txt'), 'not a resource\n');
    await assert.rejects(
      readHarvestResource('keynote-harvest://sample-deck/private-notes.txt', root),
      /not exposed by policy/
    );
  });
});

test('resource reads refuse files over the configured size limit', async (t) => {
  const previous = process.env.KEYNOTE_HARVEST_MAX_RESOURCE_BYTES;
  t.after(() => {
    if (previous === undefined) delete process.env.KEYNOTE_HARVEST_MAX_RESOURCE_BYTES;
    else process.env.KEYNOTE_HARVEST_MAX_RESOURCE_BYTES = previous;
  });

  await withHarvestRoot(async (root) => {
    const textDir = path.join(root, 'sample-deck', 'text');
    await mkdir(textDir, { recursive: true });
    await writeFile(path.join(textDir, 'big.txt'), 'x'.repeat(64 * 1024));

    process.env.KEYNOTE_HARVEST_MAX_RESOURCE_BYTES = '1000';
    await assert.rejects(
      readHarvestResource('keynote-harvest://sample-deck/text/big.txt', root),
      /over the 1000-byte resource read limit/
    );

    delete process.env.KEYNOTE_HARVEST_MAX_RESOURCE_BYTES;
    const read = await readHarvestResource('keynote-harvest://sample-deck/text/big.txt', root);
    assert.equal(read.contents[0].text.length, 64 * 1024);
  });
});

test('does not list invalid harvest directories', async () => {
  await withHarvestRoot(async (root) => {
    await mkdir(path.join(root, 'sample-deck'), { recursive: true });
    await mkdir(path.join(root, '..bad-slug'), { recursive: true });
    await writeFile(path.join(root, 'sample-deck', 'keynote-harvest-manifest.json'), '{}');
    await writeFile(path.join(root, '..bad-slug', 'keynote-harvest-manifest.json'), '{}');

    const resources = await listHarvestResources(root);
    assert.deepEqual(resources.map((resource) => resource.uri), [
      'keynote-harvest://sample-deck/keynote-harvest-manifest.json',
    ]);
  });
});
