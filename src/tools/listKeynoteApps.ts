import { z } from 'zod';
import { discoverKeynoteApps } from '../lib/keynoteApps.js';
import { assertLocalDebugAllowed, redactDisplayText } from '../lib/securityPolicy.js';
import { parseToolArgs } from '../lib/toolArgs.js';

export const listKeynoteAppsTool = {
  name: 'list_keynote_apps',
  description: 'List installed Keynote-like macOS apps and the recommended explicit app path for native export.',
  inputSchema: {
    searchApplicationsDir: z.boolean().optional(),
    includeMissingDefaults: z.boolean().optional(),
    redactionMode: z.enum(['display', 'local-debug']).optional(),
  },
  annotations: {
    title: 'List Keynote applications',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export async function listKeynoteApps(args: unknown) {
  const parsed = parseToolArgs(listKeynoteAppsTool.name, listKeynoteAppsTool.inputSchema, args);
  const redactionMode = parsed.redactionMode ?? 'display';
  assertLocalDebugAllowed(redactionMode);
  const discovery = discoverKeynoteApps({
    searchApplicationsDir: parsed.searchApplicationsDir ?? true,
    includeMissingDefaults: parsed.includeMissingDefaults ?? true,
  });
  const display = {
    candidates: discovery.candidates.map((candidate) => ({
      name: candidate.name,
      bundleId: candidate.bundleId,
      version: candidate.version,
      exists: candidate.exists,
      allowed: candidate.allowed,
      appleSigned: candidate.appleSigned,
      selected: candidate.selected,
      recommended: candidate.recommended,
    })),
    recommendedAppName: discovery.candidates.find((candidate) => candidate.path === discovery.recommendedAppPath)?.name,
    warnings: discovery.warnings.map((warning) => redactDisplayText(warning, discovery.candidates.map((candidate) => candidate.path))),
    note: discovery.note,
    redactionMode,
  };
  return redactionMode === 'local-debug' ? { ...display, localDebug: discovery } : display;
}
