import { existsSync } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { redactLocalPathsForResource } from './manifestRedaction.js';
import {
  assertHarvestSlug,
  assertResourceRelativePath,
  harvestRoot,
  isHarvestSlug,
  isPathWithin,
} from './paths.js';
import { sourceResourceAccessAllowed } from './securityPolicy.js';

type Resource = {
  uri: string;
  name: string;
  mimeType?: string;
};

export function harvestResourceScheme() {
  return process.env.KEYNOTE_HARVEST_RESOURCE_SCHEME ?? 'keynote-harvest';
}

const DEFAULT_MAX_RESOURCE_BYTES = 10 * 1024 * 1024;

function maxResourceBytes() {
  const configured = Number(process.env.KEYNOTE_HARVEST_MAX_RESOURCE_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_RESOURCE_BYTES;
}

export function harvestResourceUri(slug: string, relativePath: string) {
  return `${harvestResourceScheme()}://${assertHarvestSlug(slug)}/${assertResourceRelativePath(relativePath)}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mimeTypeFor(filePath: string) {
  if (filePath.endsWith('.json')) return 'application/json';
  if (filePath.endsWith('.txt')) return 'text/plain';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.pdf')) return 'application/pdf';
  if (filePath.endsWith('.md')) return 'text/markdown';
  return 'application/octet-stream';
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

export function isAllowedHarvestResourcePath(relativePath: string) {
  assertResourceRelativePath(relativePath);
  if (relativePath === 'keynote-harvest-manifest.json') return true;
  const segments = relativePath.split('/');
  if (segments.length !== 2) return false;
  const [directory, fileName] = segments;
  const extension = path.extname(fileName).toLowerCase();
  if (directory === 'previews' || directory === 'assets') return IMAGE_EXTENSIONS.has(extension);
  if (directory === 'text') return extension === '.txt';
  if (directory === 'source') {
    return sourceResourceAccessAllowed() && (extension === '.pdf' || fileName === 'export-summary.json');
  }
  return false;
}

function assertAllowedHarvestResourcePath(relativePath: string) {
  if (!isAllowedHarvestResourcePath(relativePath)) {
    throw new Error(`Harvest resource is not exposed by policy: ${relativePath}`);
  }
}

async function listFiles(dir: string, prefix: string, harvestDirectory: string) {
  if (!existsSync(dir)) return [];
  const [directoryRealPath, harvestRealPath] = await Promise.all([realpath(dir), realpath(harvestDirectory)]);
  if (!isPathWithin(harvestRealPath, directoryRealPath)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.posix.join(prefix, entry.name));
}

export async function resolveHarvestResourceFile(root: string, slug: string, relativePath: string) {
  assertHarvestSlug(slug);
  assertResourceRelativePath(relativePath);
  assertAllowedHarvestResourcePath(relativePath);

  try {
    const rootPath = path.resolve(root);
    const harvestDirectory = path.resolve(rootPath, slug);
    const filePath = path.resolve(harvestDirectory, relativePath);
    if (!isPathWithin(rootPath, harvestDirectory) || !isPathWithin(harvestDirectory, filePath)) {
      throw new Error('Harvest resource path escapes its configured root.');
    }

    const [rootRealPath, harvestRealPath, fileRealPath] = await Promise.all([
      realpath(rootPath),
      realpath(harvestDirectory),
      realpath(filePath),
    ]);
    if (!isPathWithin(rootRealPath, harvestRealPath) || !isPathWithin(harvestRealPath, fileRealPath)) {
      throw new Error('Harvest resource path escapes its configured root through a symbolic link.');
    }

    const fileInfo = await stat(fileRealPath);
    if (!fileInfo.isFile()) throw new Error('Harvest resource is not a file.');
    return fileRealPath;
  } catch (error) {
    if (error instanceof Error && (error.message.includes('escapes') || error.message.includes('not exposed'))) {
      throw error;
    }
    throw new Error(`Harvest resource is unavailable: ${relativePath}`);
  }
}

export async function listHarvestResources(root?: string) {
  const base = harvestRoot(root);
  if (!existsSync(base)) return [];

  const entries = await readdir(base, { withFileTypes: true });
  const resources: Resource[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !isHarvestSlug(entry.name)) continue;
    const slug = entry.name;
    const outDir = path.join(base, slug);
    const candidates = [
      'keynote-harvest-manifest.json',
      ...(sourceResourceAccessAllowed() ? await listFiles(path.join(outDir, 'source'), 'source', outDir) : []),
      ...(await listFiles(path.join(outDir, 'previews'), 'previews', outDir)),
      ...(await listFiles(path.join(outDir, 'assets'), 'assets', outDir)),
      ...(await listFiles(path.join(outDir, 'text'), 'text', outDir)),
    ].filter(isAllowedHarvestResourcePath);

    for (const relativePath of candidates) {
      try {
        const filePath = await resolveHarvestResourceFile(base, slug, relativePath);
        resources.push({
          uri: harvestResourceUri(slug, relativePath),
          name: `${slug}/${relativePath}`,
          mimeType: mimeTypeFor(filePath),
        });
      } catch {
        // Ignore broken links or entries that fail containment checks.
      }
    }
  }

  return resources;
}

export async function readHarvestResource(uri: string, root?: string) {
  const match = uri.match(new RegExp(`^${escapeRegExp(harvestResourceScheme())}://([^/]+)/(.+)$`));
  if (!match) throw new Error(`Unsupported resource URI: ${uri}`);

  const [, slug, relativePath] = match;
  const filePath = await resolveHarvestResourceFile(harvestRoot(root), slug, relativePath);
  const mimeType = mimeTypeFor(filePath);
  const fileInfo = await stat(filePath);
  const maxBytes = maxResourceBytes();
  if (fileInfo.size > maxBytes) {
    throw new Error(
      `Harvest resource "${path.basename(filePath)}" is ${fileInfo.size} bytes, over the ${maxBytes}-byte resource read limit. Raise KEYNOTE_HARVEST_MAX_RESOURCE_BYTES to read larger files.`
    );
  }
  const data = await readFile(filePath);
  if (mimeType.startsWith('text/') || mimeType === 'application/json') {
    const text = mimeType === 'application/json'
      ? `${JSON.stringify(redactLocalPathsForResource(JSON.parse(data.toString('utf8'))), null, 2)}\n`
      : data.toString('utf8');
    return {
      contents: [
        {
          uri,
          mimeType,
          text,
        },
      ],
    };
  }

  return {
    contents: [
      {
        uri,
        mimeType,
        blob: data.toString('base64'),
      },
    ],
  };
}
