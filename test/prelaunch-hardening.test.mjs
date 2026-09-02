import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isAppleSignedBundle, isKeynoteBundleTrusted } from '../dist/lib/keynoteApps.js';
import { sweepStaleStaging } from '../dist/lib/stagingCleanup.js';
import { clearFinishedJob, jobFilePath, readJob, writeJobRecord } from '../dist/lib/jobs.js';
import { readManifest } from '../dist/tools/readManifest.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a bundle identifier alone is not enough: the app must carry Apple\'s signature', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-signing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // An unsigned directory that merely claims to be Keynote.
  const impostor = path.join(root, 'Keynote.app');
  await mkdir(path.join(impostor, 'Contents'), { recursive: true });
  await writeFile(
    path.join(impostor, 'Contents', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.apple.Keynote</string></dict></plist>'
  );
  assert.equal(isAppleSignedBundle(impostor), false);
  assert.equal(isKeynoteBundleTrusted(impostor, 'com.apple.Keynote'), false, 'allowlisted id + no Apple signature must not be trusted');

  const previous = process.env.KEYNOTE_HARVEST_ALLOW_UNSIGNED_KEYNOTE;
  process.env.KEYNOTE_HARVEST_ALLOW_UNSIGNED_KEYNOTE = '1';
  try {
    assert.equal(isKeynoteBundleTrusted(impostor, 'com.apple.Keynote'), true, 'operator opt-out restores id-only trust');
  } finally {
    if (previous === undefined) delete process.env.KEYNOTE_HARVEST_ALLOW_UNSIGNED_KEYNOTE;
    else process.env.KEYNOTE_HARVEST_ALLOW_UNSIGNED_KEYNOTE = previous;
  }

  // The real thing, when present on this machine.
  for (const real of ['/Applications/Keynote.app', '/Applications/Keynote Creator Studio.app']) {
    if (process.platform !== 'darwin' || !existsSync(real)) continue;
    assert.equal(isAppleSignedBundle(real), true, `${real} should verify as Apple-signed`);
  }
  // Developer ID apps chain to Apple Root CA too; they must NOT pass.
  for (const thirdParty of ['/Applications/Google Chrome.app', '/Applications/ChatGPT.app', '/Applications/Cursor.app', '/Applications/Visual Studio Code.app']) {
    if (process.platform !== 'darwin' || !existsSync(thirdParty)) continue;
    assert.equal(isAppleSignedBundle(thirdParty), false, `${thirdParty} is Developer ID-signed and must be refused`);
  }
});

test('stale staging directories for the same destination are swept; fresh ones are kept', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-sweep-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'deck');
  const stale = path.join(root, '.deck.staging-old');
  const fresh = path.join(root, '.deck.staging-new');
  const unrelated = path.join(root, '.other.staging-old');
  for (const dir of [stale, fresh, unrelated]) await mkdir(dir);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(stale, old, old);
  await utimes(unrelated, old, old);

  const removed = sweepStaleStaging(destination, 10 * 60 * 1000);
  assert.deepEqual(removed, [stale]);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true, 'a staging directory within the timeout window must survive');
  assert.equal(existsSync(unrelated), true, 'other destinations are never touched');
});

test('a worker terminated by SIGTERM removes its staging directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-sigterm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staging = path.join(root, '.deck.staging-live');
  await mkdir(staging);
  await writeFile(path.join(staging, 'partial.png'), 'x');

  const script = `
    import { installStagingCleanup } from ${JSON.stringify(path.join(packageRoot, 'dist', 'lib', 'stagingCleanup.js'))};
    installStagingCleanup(${JSON.stringify(staging)});
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => child.stdout.once('data', resolve));
  child.kill('SIGTERM');
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 143, 'worker exits with the conventional SIGTERM status');
  assert.equal(existsSync(staging), false, 'staging directory removed on SIGTERM');
});

async function withHarvestRoot(t, body) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-prelaunch-'));
  const previousRoot = process.env.KEYNOTE_HARVEST_ROOT;
  process.env.KEYNOTE_HARVEST_ROOT = path.join(root, 'harvests');
  await mkdir(process.env.KEYNOTE_HARVEST_ROOT, { recursive: true });
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.KEYNOTE_HARVEST_ROOT;
    else process.env.KEYNOTE_HARVEST_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  });
  return body(root);
}

test('a completed background export is reported by get_harvest_manifest without a manifest', async (t) => {
  await withHarvestRoot(t, async () => {
    const startedAt = new Date().toISOString();
    writeJobRecord(jobFilePath('export-done'), {
      slug: 'export-done',
      kind: 'export',
      status: 'completed',
      startedAt,
      updatedAt: startedAt,
      finishedAt: startedAt,
      message: 'Keynote PDF export completed.',
      result: { exportedPdfHarvestPath: 'export-done/source/export-done.pdf', summaryHarvestPath: 'export-done/source/export-summary.json' },
    });
    const response = await readManifest({ slug: 'export-done' });
    assert.equal(response.responseKind, 'job-status');
    assert.equal(response.status, 'completed');
    assert.equal(response.exportedPdfHarvestPath, 'export-done/source/export-done.pdf');
    assert.match(response.note, /harvest_keynote_pdf/);

    writeJobRecord(jobFilePath('export-failed'), {
      slug: 'export-failed',
      kind: 'export',
      status: 'failed',
      startedAt,
      updatedAt: startedAt,
      finishedAt: startedAt,
      error: 'Keynote PDF export failed.',
    });
    const failed = await readManifest({ slug: 'export-failed' });
    assert.equal(failed.status, 'failed');
    assert.match(failed.note, /export failed/);
  });
});

test('job messages and errors never expose absolute paths', async (t) => {
  await withHarvestRoot(t, async () => {
    const startedAt = new Date().toISOString();
    const leakyRoot = process.env.KEYNOTE_HARVEST_ROOT;
    writeJobRecord(jobFilePath('leaky'), {
      slug: 'leaky',
      kind: 'harvest',
      status: 'running',
      startedAt,
      updatedAt: startedAt,
      pid: process.pid,
      message: `Waiting on ${leakyRoot}/.leaky.lock`,
      error: 'Timed out waiting for another writer to release /Volumes/Client-Confidential/Deck/.lock',
    });
    const response = await readManifest({ slug: 'leaky' });
    const text = JSON.stringify(response);
    assert.ok(!text.includes(leakyRoot), 'harvest root must be redacted');
    assert.ok(!text.includes('/Volumes/Client-Confidential'), 'unknown absolute paths must be redacted');
    assert.match(response.job.error, /<redacted-path>/);
  });
});

// A genuine App Store app, copied and re-labelled as Keynote: the displayed
// authority chain still says "Apple Mac OS Application Signing", but the
// bundle no longer verifies and the signed identifier does not match.
test('a modified App Store bundle claiming a Keynote identifier is refused', async (t) => {
  if (process.platform !== 'darwin') { t.skip('macOS only'); return; }
  const candidates = ['/Applications/Magnet.app', '/Applications/DaisyDisk.app', '/Applications/Wipr.app', '/Applications/Noir.app'];
  const donor = candidates.find((app) => existsSync(app));
  if (!donor) { t.skip('no small App Store app available'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-tamper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const impostor = path.join(root, 'Keynote.app');
  await cp(donor, impostor, { recursive: true });
  const plistPath = path.join(impostor, 'Contents', 'Info.plist');
  // Convert to XML if binary, then rewrite the bundle identifier.
  spawnSync('/usr/bin/plutil', ['-convert', 'xml1', plistPath]);
  const plist = await readFile(plistPath, 'utf8');
  const tampered = plist.replace(/(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]*(<\/string>)/, '$1com.apple.iWork.Keynote$2');
  assert.notEqual(tampered, plist, 'donor plist must have had a bundle identifier to replace');
  await writeFile(plistPath, tampered);

  const verify = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', impostor]);
  assert.notEqual(verify.status, 0, 'sanity: codesign must reject the tampered copy');
  assert.equal(isAppleSignedBundle(impostor, 'com.apple.iWork.Keynote'), false);
  assert.equal(isKeynoteBundleTrusted(impostor, 'com.apple.iWork.Keynote'), false, 'tampered App Store bundle must not be trusted');
});

test('an existing manifest wins over a finished export record for the same slug', async (t) => {
  await withHarvestRoot(t, async () => {
    const slug = 'export-then-harvest';
    const startedAt = new Date().toISOString();
    writeJobRecord(jobFilePath(slug), {
      slug, kind: 'export', status: 'completed', startedAt, updatedAt: startedAt, finishedAt: startedAt,
      result: { exportedPdfHarvestPath: `${slug}/source/${slug}.pdf` },
    });
    const fixture = JSON.parse(await readFile(path.join(packageRoot, 'examples/synthetic/two-slide-harvest/keynote-harvest-manifest.json'), 'utf8'));
    const outDir = path.join(process.env.KEYNOTE_HARVEST_ROOT, slug);
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'keynote-harvest-manifest.json'), JSON.stringify(fixture));
    const response = await readManifest({ slug });
    assert.equal(response.responseKind, 'manifest-summary');
    assert.equal(response.slideCount, fixture.slideCount);
    assert.equal(response.job?.kind, 'export', 'the export record is still attached for context');

    // A foreground harvest supersedes the finished record entirely.
    assert.equal(clearFinishedJob(slug), true);
    assert.equal(readJob(slug), undefined);
  });
});

test('path redaction covers paths with spaces and quoted paths', async (t) => {
  await withHarvestRoot(t, async () => {
    const startedAt = new Date().toISOString();
    writeJobRecord(jobFilePath('spaces'), {
      slug: 'spaces', kind: 'harvest', status: 'running', startedAt, updatedAt: startedAt, pid: process.pid,
      message: 'Failure at /Volumes/Client Confidential/Secret Deck.key',
      error: 'Could not read "/Volumes/Client Confidential/Secret Deck.key" (permission denied)',
    });
    const response = await readManifest({ slug: 'spaces' });
    const text = JSON.stringify(response);
    assert.ok(!text.includes('Client Confidential'), `leaked: ${text}`);
    assert.ok(!text.includes('Secret Deck'), `leaked: ${text}`);
    assert.match(response.job.error, /<redacted-path>/);
    assert.match(response.job.error, /permission denied/, 'text after a quoted path survives');
  });
});

test('a configured root name never survives redaction, even after basename substitution', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-rootname-'));
  const clientRoot = path.join(root, 'Client Confidential');
  const harvestRootDir = path.join(root, 'harvests');
  await mkdir(clientRoot, { recursive: true });
  await mkdir(harvestRootDir, { recursive: true });
  const previousRoot = process.env.KEYNOTE_HARVEST_ROOT;
  const previousInputs = process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS;
  process.env.KEYNOTE_HARVEST_ROOT = harvestRootDir;
  process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS = clientRoot;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.KEYNOTE_HARVEST_ROOT; else process.env.KEYNOTE_HARVEST_ROOT = previousRoot;
    if (previousInputs === undefined) delete process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS; else process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS = previousInputs;
    await rm(root, { recursive: true, force: true });
  });
  const startedAt = new Date().toISOString();
  writeJobRecord(jobFilePath('rootname'), {
    slug: 'rootname', kind: 'harvest', status: 'running', startedAt, updatedAt: startedAt, pid: process.pid,
    error: `Failure at ${clientRoot}/Secret Deck.key`,
  });
  const response = await readManifest({ slug: 'rootname' });
  const text = JSON.stringify(response);
  assert.ok(!text.includes('Client Confidential'), `configured root name leaked: ${text}`);
  assert.ok(!text.includes('Secret Deck'), `deck name leaked: ${text}`);
});

test('an export that finished after the manifest was written takes precedence', async (t) => {
  await withHarvestRoot(t, async () => {
    const slug = 'harvest-then-export';
    const fixture = JSON.parse(await readFile(path.join(packageRoot, 'examples/synthetic/two-slide-harvest/keynote-harvest-manifest.json'), 'utf8'));
    const outDir = path.join(process.env.KEYNOTE_HARVEST_ROOT, slug);
    await mkdir(outDir, { recursive: true });
    const manifestPath = path.join(outDir, 'keynote-harvest-manifest.json');
    await writeFile(manifestPath, JSON.stringify(fixture));
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(manifestPath, old, old);

    const finishedAt = new Date().toISOString();
    writeJobRecord(jobFilePath(slug), {
      slug, kind: 'export', status: 'completed', startedAt: finishedAt, updatedAt: finishedAt, finishedAt,
      result: { exportedPdfHarvestPath: `${slug}/source/${slug}.pdf` },
    });
    const response = await readManifest({ slug });
    assert.equal(response.responseKind, 'job-status', 'a newer export must not be hidden by an older manifest');
    assert.equal(response.exportedPdfHarvestPath, `${slug}/source/${slug}.pdf`);
  });
});

test('colon-adjacent absolute paths are redacted while URIs and MIME types survive', async (t) => {
  await withHarvestRoot(t, async () => {
    const startedAt = new Date().toISOString();
    writeJobRecord(jobFilePath('colon'), {
      slug: 'colon', kind: 'harvest', status: 'running', startedAt, updatedAt: startedAt, pid: process.pid,
      message: 'Input:/Volumes/Client Confidential/Secret Deck.key',
      error: 'Preview image/png at keynote-harvest://colon/previews/slide-001.png failed; see https://example.com/help — source /Volumes/Client Confidential/Secret Deck.key',
    });
    const response = await readManifest({ slug: 'colon' });
    assert.equal(response.job.message, 'Input:<redacted-path>');
    assert.ok(!JSON.stringify(response).includes('Client Confidential'), `leaked: ${JSON.stringify(response)}`);
    assert.match(response.job.error, /keynote-harvest:\/\/colon\/previews\/slide-001\.png/, 'resource URIs must survive');
    assert.match(response.job.error, /https:\/\/example\.com\/help/, 'web URLs must survive');
    assert.match(response.job.error, /image\/png/, 'MIME types must survive');
    assert.match(response.job.error, /<redacted-path>/);
  });
});
