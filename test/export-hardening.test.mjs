import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rmdir, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { replaceManagedOutputs } from '../dist/lib/atomicFiles.js';
import { buildKeynoteExportScript } from '../dist/lib/keynoteExportScript.js';
import { hasPdfSignature, hasPdfStructure } from '../dist/lib/pdfValidity.js';

test('the export script never closes documents it did not open', () => {
  const script = buildKeynoteExportScript('/Applications/Keynote.app');
  assert.match(script, /set documentCountBeforeOpen to count of documents/);
  assert.match(script, /set documentWasAlreadyOpen to \(\(count of documents\) is documentCountBeforeOpen\)/);
  const closeStatements = script.match(/close openedDocument saving no/g) ?? [];
  assert.ok(closeStatements.length > 0, 'the script must close documents it opened');
  for (const line of script.split('\n')) {
    if (!line.includes('close openedDocument saving no')) continue;
    assert.ok(
      line.trim().startsWith('if not documentWasAlreadyOpen then') ||
        scriptGuardsClose(script, line),
      `unguarded close statement: ${line.trim()}`
    );
  }
});

// A close on its own line must sit inside an `if not documentWasAlreadyOpen`
// block; walk backwards to the nearest block opener to check.
function scriptGuardsClose(script, closeLine) {
  const lines = script.split('\n');
  const closeIndex = lines.indexOf(closeLine);
  for (let index = closeIndex - 1; index >= 0; index -= 1) {
    const candidate = lines[index].trim();
    if (candidate === 'if not documentWasAlreadyOpen then') return true;
    if (candidate.startsWith('if ') || candidate === 'end if') return false;
  }
  return false;
}

test('hasPdfSignature accepts the PDF header and rejects everything else', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-pdf-signature-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });

  const validPath = path.join(root, 'valid.pdf');
  await writeFile(validPath, '%PDF-1.7\nsynthetic body\n%%EOF\n');
  assert.equal(hasPdfSignature(validPath), true);

  const garbagePath = path.join(root, 'garbage.pdf');
  await writeFile(garbagePath, 'Keynote error: export failed');
  assert.equal(hasPdfSignature(garbagePath), false);

  const emptyPath = path.join(root, 'empty.pdf');
  await writeFile(emptyPath, '');
  assert.equal(hasPdfSignature(emptyPath), false);

  assert.equal(hasPdfSignature(path.join(root, 'missing.pdf')), false);
});

test('hasPdfStructure rejects truncated files that still carry the header', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-pdf-structure-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });

  const completePath = path.join(root, 'complete.pdf');
  await writeFile(completePath, '%PDF-1.7\n1 0 obj\n<<>>\nendobj\nstartxref\n9\n%%EOF\n');
  assert.equal(hasPdfStructure(completePath), true);

  const truncatedPath = path.join(root, 'truncated.pdf');
  await writeFile(truncatedPath, '%PDF-1.7\nTRUNCATED');
  assert.equal(hasPdfStructure(truncatedPath), false);

  const noXrefPath = path.join(root, 'no-xref.pdf');
  await writeFile(noXrefPath, '%PDF-1.7\nbody\n%%EOF\n');
  assert.equal(hasPdfStructure(noXrefPath), false);

  assert.equal(hasPdfStructure(path.join(root, 'missing.pdf')), false);
});

test('output replacement times out on a held lock and breaks a stale one', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-replace-lock-'));
  const previousTimeout = process.env.KEYNOTE_HARVEST_REPLACE_LOCK_TIMEOUT_MS;
  const previousStale = process.env.KEYNOTE_HARVEST_REPLACE_LOCK_STALE_MS;
  t.after(async () => {
    if (previousTimeout === undefined) delete process.env.KEYNOTE_HARVEST_REPLACE_LOCK_TIMEOUT_MS;
    else process.env.KEYNOTE_HARVEST_REPLACE_LOCK_TIMEOUT_MS = previousTimeout;
    if (previousStale === undefined) delete process.env.KEYNOTE_HARVEST_REPLACE_LOCK_STALE_MS;
    else process.env.KEYNOTE_HARVEST_REPLACE_LOCK_STALE_MS = previousStale;
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });

  const destination = path.join(root, 'harvest');
  const staging = path.join(root, 'staging');
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, 'manifest.json'), '{}');

  const lockPath = path.join(root, '.harvest.lock');
  await mkdir(lockPath);
  process.env.KEYNOTE_HARVEST_REPLACE_LOCK_TIMEOUT_MS = '300';
  assert.throws(
    () => replaceManagedOutputs(destination, staging, ['manifest.json']),
    /waiting for another writer to release/
  );

  // Backdate the lock so it counts as stale; replacement then proceeds.
  const staleTime = new Date(Date.now() - 60_000);
  await utimes(lockPath, staleTime, staleTime);
  process.env.KEYNOTE_HARVEST_REPLACE_LOCK_STALE_MS = '30000';
  replaceManagedOutputs(destination, staging, ['manifest.json']);
  assert.equal(await readFile(path.join(destination, 'manifest.json'), 'utf8'), '{}');
  await assert.rejects(rmdir(lockPath), /ENOENT/);
});

test('a failed replacement restores previous outputs and removes its backup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-replace-rollback-'));
  const { chmod, readdir, rm } = await import('node:fs/promises');
  const destination = path.join(root, 'harvest');
  const readOnlyDir = path.join(destination, 'locked');
  t.after(async () => {
    await chmod(readOnlyDir, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const staging = path.join(root, 'staging');
  await mkdir(readOnlyDir, { recursive: true });
  await writeFile(path.join(destination, 'manifest.json'), 'old-manifest');
  await writeFile(path.join(readOnlyDir, 'b.txt'), 'old-b');
  await mkdir(path.join(staging, 'locked'), { recursive: true });
  await writeFile(path.join(staging, 'manifest.json'), 'new-manifest');
  await writeFile(path.join(staging, 'locked', 'b.txt'), 'new-b');
  // The read-only directory makes the second item's backup rename fail after
  // the first item has already been replaced.
  await chmod(readOnlyDir, 0o555);

  assert.throws(() => replaceManagedOutputs(destination, staging, ['manifest.json', 'locked/b.txt']));

  assert.equal(await readFile(path.join(destination, 'manifest.json'), 'utf8'), 'old-manifest');
  assert.equal(await readFile(path.join(readOnlyDir, 'b.txt'), 'utf8'), 'old-b');
  const leftovers = (await readdir(root)).filter((entry) => entry.includes('.backup-') || entry.includes('.lock'));
  assert.deepEqual(leftovers, []);
});

test('a backup that cannot be fully restored is retained and reported', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-replace-retain-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });

  const destination = path.join(root, 'harvest');
  const staging = path.join(root, 'staging');
  await mkdir(path.join(destination, 'previews'), { recursive: true });
  await writeFile(path.join(destination, 'previews', 'slide-001.png'), 'old-preview');
  await writeFile(path.join(destination, 'manifest.json'), 'old-manifest');
  await mkdir(path.join(staging, 'previews'), { recursive: true });
  await writeFile(path.join(staging, 'previews', 'slide-001.png'), 'new-preview');
  await writeFile(path.join(staging, 'manifest.json'), 'new-manifest');

  // Overlapping managed paths make the replacement fail after 'previews' was
  // backed up and then make its restore collide, so rollback cannot complete.
  assert.throws(
    () => replaceManagedOutputs(destination, staging, ['previews', 'manifest.json', 'previews/slide-001.png']),
    /previous outputs are retained at/
  );

  const { readdir } = await import('node:fs/promises');
  const backupDirs = (await readdir(root)).filter((entry) => entry.includes('.backup-'));
  assert.equal(backupDirs.length, 1, 'the backup directory must be kept when restoration fails');
  const backupContents = await readdir(path.join(root, backupDirs[0]));
  assert.ok(backupContents.includes('previews'), 'the unrestored output must remain in the backup');
  assert.equal(await readFile(path.join(destination, 'manifest.json'), 'utf8'), 'old-manifest');
});
