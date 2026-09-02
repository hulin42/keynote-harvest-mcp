import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const expectedToolNames = [
  'list_keynote_apps',
  'export_keynote_to_pdf',
  'harvest_keynote_pdf',
  'get_harvest_manifest',
  'list_harvest_outputs',
];

test('compiled server completes a spec MCP handshake and lists the harvest-only tool surface', async () => {
  const client = new Client({ name: 'keynote-harvest-smoke', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    cwd: packageRoot,
    env: {
      HOME: process.env.HOME ?? '',
      PATH: process.env.PATH ?? '',
      KEYNOTE_HARVEST_ROOT: path.join(packageRoot, 'examples', 'synthetic'),
    },
  });

  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, 'keynote-harvest');
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, 'package.json'), 'utf8')
    );
    assert.equal(client.getServerVersion()?.version, packageJson.version);

    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      expectedToolNames
    );
    const toolsByName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(toolsByName.get('get_harvest_manifest').annotations, {
      title: 'Get harvest manifest',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.equal(toolsByName.get('harvest_keynote_pdf').annotations.destructiveHint, true);
    assert.equal(toolsByName.get('harvest_keynote_pdf').annotations.openWorldHint, false);

    await client.ping();

    const resources = await client.listResources();
    assert.ok(
      resources.resources.some(
        (resource) => resource.uri === 'keynote-harvest://two-slide-harvest/keynote-harvest-manifest.json'
      )
    );

    const manifestResult = await client.callTool({
      name: 'get_harvest_manifest',
      arguments: { slug: 'two-slide-harvest' },
    });
    assert.equal(manifestResult.isError, undefined);
    const manifestPayload = JSON.parse(manifestResult.content[0].text);
    assert.equal(manifestPayload.slideCount, 2);
    assert.equal(manifestPayload.manifestHarvestPath, 'two-slide-harvest/keynote-harvest-manifest.json');
    assert.doesNotMatch(manifestResult.content[0].text, /\/Users\/|\/home\//);

    const arbitraryPathResult = await client.callTool({
      name: 'get_harvest_manifest',
      arguments: { slug: 'two-slide-harvest', manifestPath: '/tmp/private.json' },
    });
    assert.equal(arbitraryPathResult.isError, true);
    assert.match(arbitraryPathResult.content[0].text, /Unrecognized key/);

    const manifestResource = await client.readResource({
      uri: 'keynote-harvest://two-slide-harvest/keynote-harvest-manifest.json',
    });
    assert.equal(manifestResource.contents[0].mimeType, 'application/json');
    assert.doesNotMatch(manifestResource.contents[0].text, /\/Users\/|\/home\//);
  } finally {
    await client.close();
  }
});

test('compiled server answers raw newline-delimited JSON-RPC on stdio', async (context) => {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: packageRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  context.after(() => child.kill());

  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Server did not answer a newline-delimited initialize within 5s.')),
      5000
    );
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timeout);
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    child.once('error', reject);
  });

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw-ndjson-probe', version: '0.0.0' },
      },
    })}\n`
  );

  const initialized = await response;
  assert.equal(initialized.id, 1);
  assert.equal(initialized.result.serverInfo.name, 'keynote-harvest');
});
