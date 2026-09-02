import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { maxOutputBytes } from './securityPolicy.js';

export function directorySizeBytes(directory: string): number {
  if (!existsSync(directory)) return 0;
  return readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return total;
    if (entry.isDirectory()) return total + directorySizeBytes(entryPath);
    if (entry.isFile()) return total + statSync(entryPath).size;
    return total;
  }, 0);
}

export function assertOutputWithinLimit(directory: string) {
  const size = directorySizeBytes(directory);
  const limit = maxOutputBytes();
  if (size > limit) {
    throw new Error(`Generated harvest output is ${size} bytes, over the ${limit}-byte output limit.`);
  }
  return size;
}
