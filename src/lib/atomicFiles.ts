import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

function temporaryPrefix(filePath: string, label: string) {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${label}-`);
}

export function writeFileAtomically(filePath: string, contents: string | Buffer) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryDirectory = mkdtempSync(temporaryPrefix(filePath, 'write'));
  const temporaryPath = path.join(temporaryDirectory, path.basename(filePath));
  try {
    writeFileSync(temporaryPath, contents);
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function siblingTemporaryPath(filePath: string, extension = path.extname(filePath)) {
  const temporaryDirectory = mkdtempSync(temporaryPrefix(filePath, 'staging'));
  return {
    directory: temporaryDirectory,
    filePath: path.join(temporaryDirectory, `output${extension}`),
  };
}

function positiveIntegerSetting(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function sleepMilliseconds(milliseconds: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const DEFAULT_REPLACE_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_REPLACE_LOCK_STALE_MS = 10 * 60 * 1000;
const REPLACE_LOCK_POLL_MS = 100;

function acquireReplaceLock(destinationRoot: string) {
  const lockPath = path.join(path.dirname(destinationRoot), `.${path.basename(destinationRoot)}.lock`);
  const timeoutMs = positiveIntegerSetting('KEYNOTE_HARVEST_REPLACE_LOCK_TIMEOUT_MS', DEFAULT_REPLACE_LOCK_TIMEOUT_MS);
  const staleMs = positiveIntegerSetting('KEYNOTE_HARVEST_REPLACE_LOCK_STALE_MS', DEFAULT_REPLACE_LOCK_STALE_MS);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      mkdirSync(lockPath);
      return lockPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    let lockAgeMs: number | undefined;
    try {
      lockAgeMs = Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      continue; // The holder released it between mkdir and stat; retry now.
    }
    if (lockAgeMs > staleMs) {
      rmSync(lockPath, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for another writer to release ${lockPath}. If no other harvest or export is running, delete that directory and retry.`
      );
    }
    sleepMilliseconds(REPLACE_LOCK_POLL_MS);
  }
}

export function replaceManagedOutputs(
  destinationRoot: string,
  stagingRoot: string,
  managedRelativePaths: string[]
) {
  for (const relativePath of managedRelativePaths) {
    if (!existsSync(path.join(stagingRoot, relativePath))) {
      throw new Error(`Staged harvest output is incomplete: ${relativePath}`);
    }
  }

  mkdirSync(destinationRoot, { recursive: true });
  const lockPath = acquireReplaceLock(destinationRoot);
  try {
    const backupRoot = mkdtempSync(path.join(path.dirname(destinationRoot), `.${path.basename(destinationRoot)}.backup-`));
    const movedOld: string[] = [];
    const movedNew: string[] = [];

    try {
      for (const relativePath of managedRelativePaths) {
        const destinationPath = path.join(destinationRoot, relativePath);
        const backupPath = path.join(backupRoot, relativePath);
        const stagedPath = path.join(stagingRoot, relativePath);
        if (existsSync(destinationPath)) {
          mkdirSync(path.dirname(backupPath), { recursive: true });
          renameSync(destinationPath, backupPath);
          movedOld.push(relativePath);
        }
        mkdirSync(path.dirname(destinationPath), { recursive: true });
        renameSync(stagedPath, destinationPath);
        movedNew.push(relativePath);
      }
    } catch (error) {
      for (const relativePath of [...movedNew].reverse()) {
        rmSync(path.join(destinationRoot, relativePath), { recursive: true, force: true });
      }
      const unrestored: string[] = [];
      for (const relativePath of [...movedOld].reverse()) {
        const backupPath = path.join(backupRoot, relativePath);
        const destinationPath = path.join(destinationRoot, relativePath);
        if (!existsSync(backupPath)) continue;
        try {
          mkdirSync(path.dirname(destinationPath), { recursive: true });
          renameSync(backupPath, destinationPath);
        } catch {
          unrestored.push(relativePath);
        }
      }
      // The backup is the only remaining copy of anything that failed to
      // restore — keep it and say where it is.
      if (unrestored.length > 0) {
        throw new Error(
          `Replacing outputs in ${destinationRoot} failed (${error instanceof Error ? error.message : String(error)}), and restoring the previous outputs also failed for: ${unrestored.join(', ')}. The previous outputs are retained at ${backupRoot}.`
        );
      }
      rmSync(backupRoot, { recursive: true, force: true });
      throw error;
    }
    rmSync(backupRoot, { recursive: true, force: true });
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}
