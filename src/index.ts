#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { progressReporterFromExtra, type ProgressReporter } from './lib/progress.js';
import { listHarvestResources, readHarvestResource } from './lib/resources.js';
import { textContent } from './lib/responses.js';
import { redactDisplayText } from './lib/securityPolicy.js';
import { exportKeynoteToPdf, exportKeynoteToPdfTool } from './tools/exportKeynoteToPdf.js';
import { harvestKeynotePdf, harvestKeynotePdfTool } from './tools/harvestKeynotePdf.js';
import { listKeynoteApps, listKeynoteAppsTool } from './tools/listKeynoteApps.js';
import { listHarvests, listHarvestsTool } from './tools/listHarvests.js';
import { readManifest, readManifestTool } from './tools/readManifest.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string };

const server = new McpServer(
  {
    name: 'keynote-harvest',
    version: packageJson.version,
  },
  {
    capabilities: {
      resources: {},
    },
  }
);

type ToolHandler = (args: unknown, onProgress?: ProgressReporter) => Promise<unknown>;

const registrations: { tool: { name: string; description: string; inputSchema: z.ZodRawShape; annotations?: Record<string, unknown> }; handler: ToolHandler }[] = [
  { tool: listKeynoteAppsTool, handler: listKeynoteApps },
  { tool: exportKeynoteToPdfTool, handler: exportKeynoteToPdf },
  { tool: harvestKeynotePdfTool, handler: harvestKeynotePdf },
  { tool: readManifestTool, handler: readManifest },
  { tool: listHarvestsTool, handler: listHarvests },
];

for (const { tool, handler } of registrations) {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: z.object(tool.inputSchema).strict(),
      annotations: tool.annotations,
    },
    async (args: unknown, extra: unknown) => {
      try {
        return textContent(
          await handler(args, progressReporterFromExtra(extra as Parameters<typeof progressReporterFromExtra>[0]))
        );
      } catch (toolError) {
        return {
          ...textContent({
            error: redactDisplayText(toolError instanceof Error ? toolError.message : String(toolError)),
          }),
          isError: true,
        };
      }
    }
  );
}

server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: await listHarvestResources(),
}));

server.server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
  readHarvestResource(request.params.uri)
);

await server.connect(new StdioServerTransport());
