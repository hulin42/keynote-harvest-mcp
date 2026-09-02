import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { replaceManagedOutputs } from '../dist/lib/atomicFiles.js';
import {
  DEFAULT_KEYNOTE_BUNDLE_IDS,
  isAllowedKeynoteBundleId,
} from '../dist/lib/keynoteApps.js';
import { assertOutputWithinLimit } from '../dist/lib/resourceLimits.js';
import {
  assertInputPathAllowed,
  isKeynoteAppPathAllowed,
} from '../dist/lib/securityPolicy.js';

test('input roots reject outside files and symbolic-link escapes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-security-inputs-'));
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  const previousRoot = process.env.KEYNOTE_HARVEST_ROOT;
  const previousInputs = process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS;
  await mkdir(allowed, { recursive: true });
  await mkdir(outside, { recursive: true });
  const allowedFile = path.join(allowed, 'deck.pdf');
  const outsideFile = path.join(outside, 'private.pdf');
  await writeFile(allowedFile, 'allowed');
  await writeFile(outsideFile, 'outside');
  await symlink(outsideFile, path.join(allowed, 'escape.pdf'));
  process.env.KEYNOTE_HARVEST_ROOT = path.join(allowed, '.harvests');
  process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS = allowed;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.KEYNOTE_HARVEST_ROOT;
    else process.env.KEYNOTE_HARVEST_ROOT = previousRoot;
    if (previousInputs === undefined) delete process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS;
    else process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS = previousInputs;
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(assertInputPathAllowed(allowedFile, 'PDF input'), allowedFile);
  assert.throws(() => assertInputPathAllowed(outsideFile, 'PDF input'), /outside the operator-configured input roots/);
  assert.throws(() => assertInputPathAllowed(path.join(allowed, 'escape.pdf'), 'PDF input'), /outside the operator-configured input roots/);
});

test('Keynote application identities use a narrow default allowlist with operator extension', (t) => {
  const previous = process.env.KEYNOTE_HARVEST_ALLOWED_KEYNOTE_BUNDLE_IDS;
  t.after(() => {
    if (previous === undefined) delete process.env.KEYNOTE_HARVEST_ALLOWED_KEYNOTE_BUNDLE_IDS;
    else process.env.KEYNOTE_HARVEST_ALLOWED_KEYNOTE_BUNDLE_IDS = previous;
  });
  delete process.env.KEYNOTE_HARVEST_ALLOWED_KEYNOTE_BUNDLE_IDS;
  assert.deepEqual(DEFAULT_KEYNOTE_BUNDLE_IDS, ['com.apple.iWork.Keynote', 'com.apple.Keynote']);
  assert.equal(isAllowedKeynoteBundleId('com.example.FakeKeynote'), false);
  process.env.KEYNOTE_HARVEST_ALLOWED_KEYNOTE_BUNDLE_IDS = 'com.example.ManagedKeynote';
  assert.equal(isAllowedKeynoteBundleId('com.example.ManagedKeynote'), true);
});

test('Keynote application paths require an operator-approved app root and reject symlink escapes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-security-apps-'));
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  const previous = process.env.KEYNOTE_HARVEST_ALLOWED_KEYNOTE_APP_ROOTS;
  await mkdir(allowed, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(path.join(outside, 'Fake Keynote.app'));
  await symlink(path.join(outside, 'Fake Keynote.app'), path.join(allowed, 'Escape.app'));
  process.env.KEYNOTE_HARVEST_ALLOWED_KEYNOTE_APP_ROOTS = allowed;
  t.after(async () => {
    if (previous === undefined) delete process.env.KEYNOTE_HARVEST_ALLOWED_KEYNOTE_APP_ROOTS;
    else process.env.KEYNOTE_HARVEST_ALLOWED_KEYNOTE_APP_ROOTS = previous;
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(isKeynoteAppPathAllowed(path.join(allowed, 'Managed Keynote.app')), true);
  assert.equal(isKeynoteAppPathAllowed(path.join(outside, 'Fake Keynote.app')), false);
  assert.equal(isKeynoteAppPathAllowed(path.join(allowed, 'Escape.app')), false);
});

test('managed harvest replacement is all-or-rollback and preserves source files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-security-atomic-'));
  const destination = path.join(root, 'deck');
  const incomplete = path.join(root, 'incomplete');
  const staging = path.join(root, 'staging');
  try {
    await mkdir(path.join(destination, 'previews'), { recursive: true });
    await mkdir(path.join(destination, 'source'), { recursive: true });
    await writeFile(path.join(destination, 'previews', 'old.png'), 'old');
    await writeFile(path.join(destination, 'source', 'deck.pdf'), 'source');
    await mkdir(path.join(incomplete, 'previews'), { recursive: true });
    assert.throws(
      () => replaceManagedOutputs(destination, incomplete, ['previews', 'keynote-harvest-manifest.json']),
      /incomplete/
    );
    assert.equal(await readFile(path.join(destination, 'previews', 'old.png'), 'utf8'), 'old');

    await mkdir(path.join(staging, 'previews'), { recursive: true });
    await writeFile(path.join(staging, 'previews', 'new.png'), 'new');
    await writeFile(path.join(staging, 'keynote-harvest-manifest.json'), '{}');
    replaceManagedOutputs(destination, staging, ['previews', 'keynote-harvest-manifest.json']);
    assert.equal(await readFile(path.join(destination, 'previews', 'new.png'), 'utf8'), 'new');
    assert.equal(await readFile(path.join(destination, 'source', 'deck.pdf'), 'utf8'), 'source');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generated output quota rejects oversized staging data', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-security-quota-'));
  const previous = process.env.KEYNOTE_HARVEST_MAX_OUTPUT_BYTES;
  process.env.KEYNOTE_HARVEST_MAX_OUTPUT_BYTES = '10';
  t.after(async () => {
    if (previous === undefined) delete process.env.KEYNOTE_HARVEST_MAX_OUTPUT_BYTES;
    else process.env.KEYNOTE_HARVEST_MAX_OUTPUT_BYTES = previous;
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'large.txt'), 'x'.repeat(100));
  assert.throws(() => assertOutputWithinLimit(root), /output limit/);
});
