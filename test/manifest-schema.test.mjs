import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  collectKeynoteHarvestManifestErrors,
  validateKeynoteHarvestManifest,
} from '../dist/schema/validateManifest.js';
import { CURRENT_KEYNOTE_HARVEST_MANIFEST_VERSION } from '../dist/schema/version.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(packageRoot, relativePath), 'utf8'));
}

test('the synthetic fixture is a valid versioned manifest', async () => {
  const fixture = await readJson('examples/synthetic/two-slide-harvest/keynote-harvest-manifest.json');
  assert.doesNotThrow(() => validateKeynoteHarvestManifest(fixture));
  assert.equal(fixture.schemaVersion, CURRENT_KEYNOTE_HARVEST_MANIFEST_VERSION);
});

test('the distributed JSON Schema and runtime version stay aligned', async () => {
  const schema = await readJson('schema/keynote-harvest-manifest-v1.schema.json');
  assert.equal(schema.properties.schemaVersion.const, CURRENT_KEYNOTE_HARVEST_MANIFEST_VERSION);
  assert.ok(schema.required.includes('schemaVersion'));
  assert.ok(schema.required.includes('slides'));
  assert.ok(schema.required.includes('assets'));
});

test('runtime validation rejects inconsistent manifests', async () => {
  const fixture = await readJson('examples/synthetic/two-slide-harvest/keynote-harvest-manifest.json');
  const invalid = { ...fixture, slideCount: 3 };
  assert.deepEqual(collectKeynoteHarvestManifestErrors(invalid), ['slides length must match slideCount']);
  assert.throws(() => validateKeynoteHarvestManifest(invalid), /slides length must match slideCount/);
});

function withSyntheticAsset(fixture) {
  const manifest = structuredClone(fixture);
  manifest.assets = [
    {
      id: 'slide-001-asset-001',
      kind: 'embedded-image',
      path: 'keynote-harvest://two-slide-harvest/assets/slide-001-asset-001.png',
      sourceSlideId: 'slide-001',
    },
  ];
  manifest.slides[0].assetIds = ['slide-001-asset-001'];
  return manifest;
}

// Every mutation here must fail BOTH the runtime validator and the
// distributed JSON Schema, so the two cannot drift apart silently.
const PARITY_REJECTIONS = [
  ['a null text run', (manifest) => manifest.slides[0].textRuns.push(null)],
  ['a text run with a numeric id', (manifest) => manifest.slides[0].textRuns.push({ id: 7, text: 'x' })],
  ['a text run missing its text', (manifest) => manifest.slides[0].textRuns.push({ id: 'run-x' })],
  ['a text run with an invalid role', (manifest) => manifest.slides[0].textRuns.push({ id: 'run-x', text: 'x', role: 'hero' })],
  ['a string preview', (manifest) => { manifest.slides[0].preview = 'previews/slide-001.png'; }],
  ['a numeric assetIds element', (manifest) => { manifest.slides[0].assetIds = [42]; }],
  ['an asset missing path and kind', (manifest) => { manifest.assets = [{ id: 'a-1', sourceSlideId: 'slide-001' }]; }],
  ['an asset with an invalid kind', (manifest) => { manifest.assets = [{ id: 'a-1', kind: 'gif', path: null, sourceSlideId: 'slide-001' }]; }],
  ['a warning with an invalid code', (manifest) => { manifest.warnings = [{ id: 'w-1', code: 'oops', severity: 'warning', message: 'x' }]; }],
  ['a warning missing its message', (manifest) => { manifest.warnings = [{ id: 'w-1', code: 'unknown', severity: 'info' }]; }],
  ['a confidence above 1', (manifest) => { manifest.slides[0].textRuns[0].confidence = 2; }],
  ['an array-valued role', (manifest) => { manifest.slides[0].textRuns[0].role = ['title']; }],
  ['a negative preview width', (manifest) => { manifest.slides[0].preview.width = -10; }],
  ['an invalid export source kind', (manifest) => { manifest.source.export = { sourceKind: 'powerpoint' }; }],
  ['an invalid export status', (manifest) => { manifest.source.export = { sourceKind: 'keynote', exportStatus: 'done' }; }],
  ['a non-date harvestedAt', (manifest) => { manifest.harvestedAt = 'yesterday'; }],
  ['a malformed slide warning', (manifest) => { manifest.slides[0].warnings = [{ id: 'w-1' }]; }],
  ['an impossible calendar date', (manifest) => { manifest.harvestedAt = '2026-02-30T10:00:00Z'; }],
  ['an object-valued source display name', (manifest) => { manifest.source.displayName = { name: 'x' }; }],
  ['a numeric preview mime type', (manifest) => { manifest.slides[0].preview.mimeType = 7; }],
  ['a string-valued redaction flag', (manifest) => { manifest.slides[0].textRuns[0].redacted = 'yes'; }],
  ['a string-valued export timeout flag', (manifest) => { manifest.source.export = { sourceKind: 'keynote', timedOut: 'no' }; }],
];

test('runtime validation matches the distributed schema on nested records', async () => {
  const fixture = await readJson('examples/synthetic/two-slide-harvest/keynote-harvest-manifest.json');
  const schema = await readJson('schema/keynote-harvest-manifest-v1.schema.json');
  const ajv = new Ajv2020.default({ allErrors: true });
  addFormats.default(ajv, { mode: 'full' });
  const validateWithSchema = ajv.compile(schema);

  assert.equal(validateWithSchema(fixture), true, JSON.stringify(validateWithSchema.errors));
  assert.deepEqual(collectKeynoteHarvestManifestErrors(fixture), []);

  const withAsset = withSyntheticAsset(fixture);
  assert.equal(validateWithSchema(withAsset), true, JSON.stringify(validateWithSchema.errors));
  assert.deepEqual(collectKeynoteHarvestManifestErrors(withAsset), []);

  for (const [label, mutate] of PARITY_REJECTIONS) {
    const mutated = structuredClone(fixture);
    mutate(mutated);
    assert.equal(validateWithSchema(mutated), false, `schema should reject ${label}`);
    assert.notDeepEqual(collectKeynoteHarvestManifestErrors(mutated), [], `runtime validator should reject ${label}`);
  }
});

test('runtime validation enforces slide and asset cross-references', async () => {
  const fixture = await readJson('examples/synthetic/two-slide-harvest/keynote-harvest-manifest.json');

  const unknownAssetReference = structuredClone(fixture);
  unknownAssetReference.slides[0].assetIds = ['missing-asset'];
  assert.deepEqual(collectKeynoteHarvestManifestErrors(unknownAssetReference), [
    'slides[0].assetIds[0] does not match any asset id',
  ]);

  const unknownSlideReference = withSyntheticAsset(fixture);
  unknownSlideReference.assets[0].sourceSlideId = 'slide-999';
  assert.deepEqual(collectKeynoteHarvestManifestErrors(unknownSlideReference), [
    'assets[0].sourceSlideId does not match any slide id',
  ]);
});

test('pre-versioned manifests require explicit legacy compatibility', async () => {
  const fixture = await readJson('examples/synthetic/two-slide-harvest/keynote-harvest-manifest.json');
  const legacy = { ...fixture };
  delete legacy.schemaVersion;
  assert.throws(() => validateKeynoteHarvestManifest(legacy), /schemaVersion/);
  assert.doesNotThrow(() => validateKeynoteHarvestManifest(legacy, { allowLegacyVersion: true }));
});
