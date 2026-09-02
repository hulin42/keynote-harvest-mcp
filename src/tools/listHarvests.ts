import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { harvestResponsePathExposure, localPathRedactionMode, pathExposureForMode } from '../lib/pathPolicy.js';
import { harvestRoot, isHarvestSlug } from '../lib/paths.js';
import { assertLocalDebugAllowed } from '../lib/securityPolicy.js';
import { parseToolArgs } from '../lib/toolArgs.js';

export const listHarvestsTool = {
  name: 'list_harvest_outputs',
  description: 'List known harvest output folders and whether they contain a harvest manifest.',
  inputSchema: {
    redactionMode: z.enum(['display', 'local-debug']).optional(),
  },
  annotations: {
    title: 'List harvest outputs',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export async function listHarvests(args: unknown) {
  const parsed = parseToolArgs(listHarvestsTool.name, listHarvestsTool.inputSchema, args);
  const redactionMode = localPathRedactionMode(parsed.redactionMode);
  assertLocalDebugAllowed(redactionMode);
  const root = harvestRoot();
  const responseBase = {
    harvestRootDisplayName: path.basename(root),
    redactionMode,
    pathExposure: pathExposureForMode(harvestResponsePathExposure, redactionMode),
  };
  if (!existsSync(root)) {
    return {
      ...responseBase,
      ...(redactionMode === 'local-debug' ? { harvestRoot: root } : {}),
      outputs: [],
    };
  }

  const entries = await readdir(root, { withFileTypes: true });
  const outputs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isHarvestSlug(entry.name)) continue;
    const outDir = path.join(root, entry.name);
    const info = await stat(outDir);
    outputs.push({
      slug: entry.name,
      outputRelativePath: entry.name,
      ...(redactionMode === 'local-debug' ? { outputDirectory: outDir } : {}),
      hasManifest: existsSync(path.join(outDir, 'keynote-harvest-manifest.json')),
      modifiedAt: info.mtime.toISOString(),
    });
  }

  return {
    ...responseBase,
    ...(redactionMode === 'local-debug' ? { harvestRoot: root } : {}),
    outputs: outputs.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
  };
}
