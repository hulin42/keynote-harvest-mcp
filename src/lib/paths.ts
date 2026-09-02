import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(here, '../..');

export const HARVEST_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

export function isHarvestSlug(value: string) {
  return HARVEST_SLUG_PATTERN.test(value);
}

export function assertHarvestSlug(value: string) {
  if (!isHarvestSlug(value)) {
    throw new Error(
      `Invalid harvest slug "${value}". Use 1-100 lowercase letters, numbers, or hyphens, beginning and ending with a letter or number.`
    );
  }
  return value;
}

export function assertResourceRelativePath(value: string) {
  if (!value || path.posix.isAbsolute(value) || value.includes('\\') || value.includes('\0')) {
    throw new Error(`Invalid harvest resource path: ${value}`);
  }

  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Invalid harvest resource path: ${value}`);
  }

  return value;
}

export function isPathWithin(parentPath: string, candidatePath: string) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function workingRoot() {
  return process.env.KEYNOTE_HARVEST_WORKING_DIRECTORY
    ? path.resolve(process.env.KEYNOTE_HARVEST_WORKING_DIRECTORY)
    : process.cwd();
}

export function resolveFromWorkingDirectory(value: string) {
  return path.isAbsolute(value) ? value : path.resolve(workingRoot(), value);
}

export function harvestRoot(root = process.env.KEYNOTE_HARVEST_ROOT ?? '.harvests') {
  return resolveFromWorkingDirectory(root);
}

export function defaultHarvestOutDir(slug: string, root?: string) {
  return path.join(harvestRoot(root), assertHarvestSlug(slug));
}

export function realpathNearestExistingAncestor(target: string) {
  let current = path.resolve(target);
  const pendingSegments: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    pendingSegments.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realpathSync(current), ...pendingSegments);
}

export function outsideHarvestRootAllowed() {
  const value = process.env.KEYNOTE_HARVEST_ALLOW_OUTSIDE_ROOT;
  return value === '1' || value?.toLowerCase() === 'true';
}

export function assertOutsideHarvestRootAllowed() {
  if (!outsideHarvestRootAllowed()) {
    throw new Error(
      'Writing outside the harvest root requires operator authorization: set KEYNOTE_HARVEST_ALLOW_OUTSIDE_ROOT=1 in the server environment. The allowOutsideHarvestRoot argument alone does not grant it, since the calling agent can set that argument itself.'
    );
  }
}

export function assertOutPathWithinHarvestRoot(outPath: string) {
  const root = harvestRoot();
  const contained =
    isPathWithin(root, outPath) &&
    isPathWithin(realpathNearestExistingAncestor(root), realpathNearestExistingAncestor(outPath));
  if (!contained) {
    throw new Error(
      `Output path "${path.basename(outPath)}" resolves outside the harvest root. Writes are contained to the harvest root (KEYNOTE_HARVEST_ROOT) by default; pass allowOutsideHarvestRoot: true to write elsewhere.`
    );
  }
  return outPath;
}

export function manifestPathForOutDir(outDir: string) {
  return path.join(outDir, 'keynote-harvest-manifest.json');
}

export function cliPath(fileName: string) {
  return path.join(PACKAGE_ROOT, 'dist', 'cli', fileName);
}
