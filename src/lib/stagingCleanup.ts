import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

// Workers stage output beside the destination and rely on a `finally` to
// remove it. That never runs when a host tears the worker down with a
// signal, so install an explicit handler for the staging directory.
export function installStagingCleanup(stagingDirectory: string, onSignal?: (signal: NodeJS.Signals) => void) {
  const handler = (signal: NodeJS.Signals) => {
    try {
      onSignal?.(signal);
    } catch {
      // Best effort; the directory removal below is what matters.
    }
    rmSync(stagingDirectory, { recursive: true, force: true });
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
  };
  process.once('SIGTERM', handler);
  process.once('SIGINT', handler);
  return () => {
    process.off('SIGTERM', handler);
    process.off('SIGINT', handler);
  };
}

// Remove staging directories for the same destination that outlived the
// command timeout — leftovers from workers that were hard-killed.
export function sweepStaleStaging(destinationPath: string, maxAgeMs: number, now = Date.now()) {
  const parent = path.dirname(destinationPath);
  const prefix = `.${path.basename(destinationPath)}.staging-`;
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const candidate = path.join(parent, entry);
    try {
      if (now - statSync(candidate).mtimeMs <= maxAgeMs) continue;
      rmSync(candidate, { recursive: true, force: true });
      removed.push(candidate);
    } catch {
      // Another process may have removed it; ignore.
    }
  }
  return removed;
}
