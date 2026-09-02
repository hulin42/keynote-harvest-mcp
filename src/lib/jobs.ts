import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomically } from './atomicFiles.js';
import { assertHarvestSlug, harvestRoot } from './paths.js';
import { subprocessEnvironment } from './securityPolicy.js';

export type HarvestJobKind = 'harvest' | 'export';
export type HarvestJobStatus = 'running' | 'completed' | 'failed';

export type HarvestJob = {
  slug: string;
  kind: HarvestJobKind;
  status: HarvestJobStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  pid?: number;
  progress?: { page: number; total: number };
  message?: string;
  phases?: string[];
  error?: string;
  result?: Record<string, unknown>;
};

// Background jobs live beside the slug directories under a name that can
// never be a harvest slug, so resource listing (which only walks slug
// directories) never exposes them.
export const JOBS_DIRECTORY_NAME = '.jobs';

export function jobsDirectory(root = harvestRoot()) {
  return path.join(root, JOBS_DIRECTORY_NAME);
}

export function jobFilePath(slug: string, root = harvestRoot()) {
  return path.join(jobsDirectory(root), `${assertHarvestSlug(slug)}.json`);
}

export function jobLogPath(slug: string, root = harvestRoot()) {
  return path.join(jobsDirectory(root), `${assertHarvestSlug(slug)}.log`);
}

export function readJobRecord(filePath: string): HarvestJob | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<HarvestJob>;
    if (!parsed || typeof parsed.slug !== 'string' || typeof parsed.status !== 'string') return undefined;
    return parsed as HarvestJob;
  } catch {
    return undefined;
  }
}

export function writeJobRecord(filePath: string, job: HarvestJob) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomically(filePath, `${JSON.stringify(job, null, 2)}\n`);
}

// Read-modify-write for workers reporting progress. Missing records are
// tolerated (the worker keeps going; only status reporting is lost).
export function updateJobRecord(filePath: string, patch: Partial<HarvestJob>) {
  const current = readJobRecord(filePath);
  if (!current) return;
  writeJobRecord(filePath, { ...current, ...patch, updatedAt: new Date().toISOString() });
}

export function readJob(slug: string, root = harvestRoot()) {
  return readJobRecord(jobFilePath(slug, root));
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A "running" record whose worker has vanished (killed, crashed before it
// could record a result) is reported as failed rather than running forever.
export function effectiveJobStatus(job: HarvestJob): HarvestJob {
  if (job.status !== 'running' || job.pid === undefined || processIsAlive(job.pid)) return job;
  return {
    ...job,
    status: 'failed',
    error: job.error ?? 'The background worker exited without recording a result.',
  };
}

export function jobHarvestPath(slug: string) {
  return `${JOBS_DIRECTORY_NAME}/${assertHarvestSlug(slug)}.json`;
}

// Starts a worker detached from the MCP server process so it survives a host
// abandoning the tool call (or the server itself being torn down). The
// worker owns its job record from here: progress, completion, or failure.
export function launchBackgroundJob(options: {
  slug: string;
  kind: HarvestJobKind;
  commandArgs: string[];
  root?: string;
  result?: Record<string, unknown>;
}) {
  const filePath = jobFilePath(options.slug, options.root);
  const existing = readJobRecord(filePath);
  if (existing && effectiveJobStatus(existing).status === 'running') {
    throw new Error(
      `A background ${existing.kind} for slug "${options.slug}" is already running (started ${existing.startedAt}). Wait for it to finish or use a different slug.`
    );
  }

  const startedAt = new Date().toISOString();
  writeJobRecord(filePath, {
    slug: options.slug,
    kind: options.kind,
    status: 'running',
    startedAt,
    updatedAt: startedAt,
    message: 'Worker launching',
    ...(options.result ? { result: options.result } : {}),
  });

  const logDescriptor = openSync(jobLogPath(options.slug, options.root), 'w');
  try {
    const child = spawn(process.execPath, [...options.commandArgs, '--job-file', filePath], {
      detached: true,
      stdio: ['ignore', logDescriptor, logDescriptor],
      env: subprocessEnvironment(),
    });
    child.unref();
    updateJobRecord(filePath, { pid: child.pid });
    return { startedAt, pid: child.pid, jobHarvestPath: jobHarvestPath(options.slug) };
  } finally {
    closeSync(logDescriptor);
  }
}

// A foreground run for a slug supersedes any finished background record for
// it, so status reads reflect the newest work.
export function clearFinishedJob(slug: string, root = harvestRoot()) {
  const filePath = jobFilePath(slug, root);
  const existing = readJobRecord(filePath);
  if (!existing) return false;
  if (effectiveJobStatus(existing).status === 'running') return false;
  rmSync(filePath, { force: true });
  rmSync(jobLogPath(slug, root), { force: true });
  return true;
}
