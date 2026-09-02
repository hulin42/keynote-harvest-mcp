import assert from 'node:assert/strict';
import test from 'node:test';
import { augmentedToolPath } from '../dist/lib/toolPath.js';
import { runCommand } from '../dist/lib/runCommand.js';

function withPopplerPathEnv(value, run) {
  const previous = process.env.KEYNOTE_HARVEST_POPPLER_PATH;
  if (value === undefined) delete process.env.KEYNOTE_HARVEST_POPPLER_PATH;
  else process.env.KEYNOTE_HARVEST_POPPLER_PATH = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.KEYNOTE_HARVEST_POPPLER_PATH;
    else process.env.KEYNOTE_HARVEST_POPPLER_PATH = previous;
  }
}

test('appends Homebrew and MacPorts directories to a minimal GUI-host PATH', () => {
  withPopplerPathEnv(undefined, () => {
    const parts = augmentedToolPath('/usr/bin:/bin:/usr/sbin:/sbin').split(':');
    assert.deepEqual(parts.slice(0, 4), ['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
    assert.ok(parts.includes('/opt/homebrew/bin'));
    assert.ok(parts.includes('/usr/local/bin'));
    assert.ok(parts.includes('/opt/local/bin'));
  });
});

test('does not duplicate directories already on PATH', () => {
  withPopplerPathEnv(undefined, () => {
    const parts = augmentedToolPath('/opt/homebrew/bin:/usr/bin').split(':');
    assert.equal(parts.filter((part) => part === '/opt/homebrew/bin').length, 1);
  });
});

test('prepends KEYNOTE_HARVEST_POPPLER_PATH so the override wins', () => {
  withPopplerPathEnv('/custom/poppler/bin', () => {
    const parts = augmentedToolPath('/usr/bin:/bin').split(':');
    assert.equal(parts[0], '/custom/poppler/bin');
  });
});

test('runCommand kills a hung child and reports a timeout', async () => {
  await assert.rejects(
    runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 }),
    /timed out after 300ms/
  );
});

test('runCommand still resolves fast commands under a timeout', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], { timeoutMs: 30000 });
  assert.equal(result.stdout, 'ok');
});

test('runCommand does not pass unrelated host secrets to worker processes', async (t) => {
  const previous = process.env.KEYNOTE_HARVEST_TEST_SECRET;
  const unrelatedPrevious = process.env.UNRELATED_PRIVATE_TOKEN;
  process.env.KEYNOTE_HARVEST_TEST_SECRET = 'allowed-keynote-setting';
  process.env.UNRELATED_PRIVATE_TOKEN = 'must-not-leak';
  t.after(() => {
    if (previous === undefined) delete process.env.KEYNOTE_HARVEST_TEST_SECRET;
    else process.env.KEYNOTE_HARVEST_TEST_SECRET = previous;
    if (unrelatedPrevious === undefined) delete process.env.UNRELATED_PRIVATE_TOKEN;
    else process.env.UNRELATED_PRIVATE_TOKEN = unrelatedPrevious;
  });

  const result = await runCommand(process.execPath, [
    '-e',
    'process.stdout.write(JSON.stringify({ allowed: process.env.KEYNOTE_HARVEST_TEST_SECRET, private: process.env.UNRELATED_PRIVATE_TOKEN }))',
  ]);
  assert.deepEqual(JSON.parse(result.stdout), { allowed: 'allowed-keynote-setting' });
});

test('runCommand bounds captured child output', async (t) => {
  const previous = process.env.KEYNOTE_HARVEST_MAX_COMMAND_OUTPUT_BYTES;
  const previousGrace = process.env.KEYNOTE_HARVEST_COMMAND_KILL_GRACE_MS;
  process.env.KEYNOTE_HARVEST_MAX_COMMAND_OUTPUT_BYTES = '100';
  process.env.KEYNOTE_HARVEST_COMMAND_KILL_GRACE_MS = '25';
  t.after(() => {
    if (previous === undefined) delete process.env.KEYNOTE_HARVEST_MAX_COMMAND_OUTPUT_BYTES;
    else process.env.KEYNOTE_HARVEST_MAX_COMMAND_OUTPUT_BYTES = previous;
    if (previousGrace === undefined) delete process.env.KEYNOTE_HARVEST_COMMAND_KILL_GRACE_MS;
    else process.env.KEYNOTE_HARVEST_COMMAND_KILL_GRACE_MS = previousGrace;
  });
  const startedAt = Date.now();
  await assert.rejects(
    runCommand(process.execPath, [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => process.stdout.write("x".repeat(1000)), 5)',
    ]),
    /command-output limit/
  );
  assert.ok(Date.now() - startedAt < 2000, 'output-limited child should be force-killed after the grace period');
});
