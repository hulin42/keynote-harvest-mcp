import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'keynote-harvest-packed-runtime-'));
const archiveDirectory = path.join(temporaryRoot, 'archive');
const consumerDirectory = path.join(temporaryRoot, 'consumer');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function listPackedTools(serverPath) {
  const client = new Client({ name: 'keynote-harvest-packed-rehearsal', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: serverPath,
    args: [],
    cwd: consumerDirectory,
  });

  try {
    await client.connect(transport);
    return await client.listTools();
  } finally {
    await client.close();
  }
}

try {
  await mkdir(archiveDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });
  const packed = JSON.parse(
    run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', archiveDirectory], packageRoot)
  );
  const archivePath = path.join(archiveDirectory, packed[0].filename);

  await writeFile(
    path.join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ name: 'keynote-harvest-packed-consumer', private: true }, null, 2)}\n`
  );
  run('npm', ['install', archivePath, '--ignore-scripts', '--no-audit', '--no-fund'], consumerDirectory);

  const installedPackageRoot = path.join(
    consumerDirectory,
    'node_modules',
    ...packed[0].name.split('/')
  );
  const schema = JSON.parse(
    await readFile(path.join(installedPackageRoot, 'schema', 'keynote-harvest-manifest-v1.schema.json'), 'utf8')
  );
  assert.equal(schema.properties.schemaVersion.const, 'keynote-harvest-manifest-v1');

  const serverPath = path.join(consumerDirectory, 'node_modules', '.bin', 'keynote-harvest-mcp');
  const listed = await listPackedTools(serverPath);
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    [
      'list_keynote_apps',
      'export_keynote_to_pdf',
      'harvest_keynote_pdf',
      'get_harvest_manifest',
      'list_harvest_outputs',
    ]
  );
  console.log(`Packed runtime rehearsal passed with ${packed[0].entryCount} files (${packed[0].size} bytes).`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
