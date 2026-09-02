import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  effectiveJobStatus,
  jobFilePath,
  launchBackgroundJob,
  readJob,
  readJobRecord,
  updateJobRecord,
  writeJobRecord,
} from '../dist/lib/jobs.js';
import { harvestKeynotePdf } from '../dist/tools/harvestKeynotePdf.js';
import { readManifest } from '../dist/tools/readManifest.js';

async function withHarvestRoot(t, body) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keynote-jobs-'));
  const previousRoot = process.env.KEYNOTE_HARVEST_ROOT;
  const previousInputs = process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS;
  process.env.KEYNOTE_HARVEST_ROOT = path.join(root, 'harvests');
  process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS = path.join(root, 'inputs');
  await mkdir(process.env.KEYNOTE_HARVEST_ROOT, { recursive: true });
  await mkdir(process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS, { recursive: true });
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.KEYNOTE_HARVEST_ROOT;
    else process.env.KEYNOTE_HARVEST_ROOT = previousRoot;
    if (previousInputs === undefined) delete process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS;
    else process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS = previousInputs;
    await rm(root, { recursive: true, force: true });
  });
  return body(root);
}

async function waitForJob(slug, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = readJob(slug);
    if (job && predicate(job)) return job;
    if (Date.now() > deadline) throw new Error(`job ${slug} did not reach the expected state: ${JSON.stringify(job)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('job records round-trip and a vanished worker reads as failed', async (t) => {
  await withHarvestRoot(t, async () => {
    const filePath = jobFilePath('job-roundtrip');
    const startedAt = new Date().toISOString();
    writeJobRecord(filePath, { slug: 'job-roundtrip', kind: 'harvest', status: 'running', startedAt, updatedAt: startedAt });
    updateJobRecord(filePath, { progress: { page: 3, total: 9 }, message: 'page 3' });
    const stored = readJobRecord(filePath);
    assert.equal(stored.progress.page, 3);
    assert.equal(stored.message, 'page 3');
    assert.ok(stored.updatedAt >= startedAt);

    // A live pid (this process) keeps the job running; an impossible pid does not.
    assert.equal(effectiveJobStatus({ ...stored, pid: process.pid }).status, 'running');
    const vanished = effectiveJobStatus({ ...stored, pid: 2147483646 });
    assert.equal(vanished.status, 'failed');
    assert.match(vanished.error, /exited without recording/);
  });
});

test('get_harvest_manifest reports a running background job before any manifest exists', async (t) => {
  await withHarvestRoot(t, async () => {
    const startedAt = new Date().toISOString();
    writeJobRecord(jobFilePath('job-running'), {
      slug: 'job-running',
      kind: 'harvest',
      status: 'running',
      startedAt,
      updatedAt: startedAt,
      pid: process.pid,
      progress: { page: 12, total: 56 },
      message: 'Harvested page 12 of 56',
    });
    const status = await readManifest({ slug: 'job-running' });
    assert.equal(status.status, 'running');
    assert.equal(status.background, true);
    assert.deepEqual(status.job.progress, { page: 12, total: 56 });
    assert.equal(status.job.jobHarvestPath, '.jobs/job-running.json');
  });
});

test('a failed background job surfaces its error through get_harvest_manifest', async (t) => {
  await withHarvestRoot(t, async () => {
    const startedAt = new Date().toISOString();
    writeJobRecord(jobFilePath('job-failed'), {
      slug: 'job-failed',
      kind: 'harvest',
      status: 'failed',
      startedAt,
      updatedAt: startedAt,
      error: 'pdfinfo failed: not a PDF',
    });
    await assert.rejects(readManifest({ slug: 'job-failed' }), /background harvest for "job-failed" failed: pdfinfo failed/);
  });
});

test('runInBackground returns immediately and the detached worker records its own failure', async (t) => {
  await withHarvestRoot(t, async () => {
    const inputPath = path.join(process.env.KEYNOTE_HARVEST_ALLOWED_INPUT_ROOTS, 'broken.pdf');
    await writeFile(inputPath, 'this is not a pdf');
    const startedAt = process.hrtime.bigint();
    const response = await harvestKeynotePdf({
      pdfPath: inputPath,
      slug: 'job-broken',
      title: 'Broken',
      runInBackground: true,
    });
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    assert.equal(response.status, 'running');
    assert.equal(response.background, true);
    assert.equal(response.jobHarvestPath, '.jobs/job-broken.json');
    assert.ok(elapsedMs < 2000, `background launch took ${elapsedMs}ms`);

    // Whether Poppler is installed or not, a non-PDF input fails fast, and the
    // worker — not the server — writes the terminal state.
    const finished = await waitForJob('job-broken', (job) => job.status !== 'running');
    assert.equal(finished.status, 'failed');
    assert.ok(finished.error && finished.error.length > 0, 'failure must carry an error message');
    assert.ok(finished.finishedAt, 'failure must record finishedAt');
    await assert.rejects(readManifest({ slug: 'job-broken' }), /background harvest for "job-broken" failed/);
    // The worker logs before recording its terminal status, but the file
    // write can still be in flight on a slow runner; allow a short settle.
    const logPath = path.join(process.env.KEYNOTE_HARVEST_ROOT, '.jobs', 'job-broken.log');
    let log = '';
    for (let attempt = 0; attempt < 50 && log.length === 0; attempt += 1) {
      log = await readFile(logPath, 'utf8');
      if (log.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(log.length > 0, 'worker output is captured in the job log');
  });
});

test('a second background job for a slug still running is refused', async (t) => {
  await withHarvestRoot(t, async () => {
    const startedAt = new Date().toISOString();
    writeJobRecord(jobFilePath('job-busy'), {
      slug: 'job-busy',
      kind: 'harvest',
      status: 'running',
      startedAt,
      updatedAt: startedAt,
      pid: process.pid,
    });
    assert.throws(
      () => launchBackgroundJob({ slug: 'job-busy', kind: 'harvest', commandArgs: ['-e', '0'] }),
      /already running/
    );
  });
});
