import assert from 'node:assert/strict';
import test from 'node:test';
import { exportKeynoteToPdf } from '../dist/tools/exportKeynoteToPdf.js';
import { harvestKeynotePdf } from '../dist/tools/harvestKeynotePdf.js';
import { listHarvests } from '../dist/tools/listHarvests.js';
import { readManifest } from '../dist/tools/readManifest.js';

test('missing required arguments fail fast with a field-by-field message', async () => {
  await assert.rejects(harvestKeynotePdf({}), /Invalid arguments for harvest_keynote_pdf: slug: .*; title: /);
  await assert.rejects(exportKeynoteToPdf({}), /Invalid arguments for export_keynote_to_pdf: keynotePath: /);
  await assert.rejects(readManifest({}), /Invalid arguments for get_harvest_manifest: slug: /);
});

test('wrong types are rejected before any command runs', async () => {
  await assert.rejects(
    harvestKeynotePdf({ pdfPath: 'deck.pdf', slug: 'deck', title: 'Deck', previewDpi: '300' }),
    /previewDpi: Expected number/
  );
  await assert.rejects(
    exportKeynoteToPdf({ keynotePath: 42 }),
    /keynotePath: Expected string/
  );
});

test('range and format constraints are enforced at the tool layer', async () => {
  await assert.rejects(
    harvestKeynotePdf({ pdfPath: 'deck.pdf', slug: 'deck', title: 'Deck', previewDpi: 20 }),
    /previewDpi: /
  );
  await assert.rejects(
    harvestKeynotePdf({ pdfPath: 'deck.pdf', slug: 'deck', title: 'Deck', maxPages: 0 }),
    /maxPages: /
  );
  await assert.rejects(
    harvestKeynotePdf({ pdfPath: 'deck.pdf', slug: 'Bad Slug!', title: 'Deck' }),
    /slug: Use 1-100 lowercase letters/
  );
  await assert.rejects(
    listHarvests({ redactionMode: 'raw' }),
    /redactionMode: /
  );
  await assert.rejects(listHarvests({ harvestRoot: '/tmp' }), /Unrecognized key/);
});

test('unknown argument keys are rejected', async () => {
  await assert.rejects(
    harvestKeynotePdf({ pdfPath: 'deck.pdf', slug: 'deck', title: 'Deck', extractimages: true }),
    /Unrecognized key/
  );
});

test('PDF inputs require exactly one local or harvest-relative path', async () => {
  await assert.rejects(
    harvestKeynotePdf({ slug: 'deck', title: 'Deck' }),
    /exactly one of pdfPath or harvestPdfPath/
  );
  await assert.rejects(
    harvestKeynotePdf({ pdfPath: 'deck.pdf', harvestPdfPath: 'deck/source/deck.pdf', slug: 'deck', title: 'Deck' }),
    /exactly one of pdfPath or harvestPdfPath/
  );
});
