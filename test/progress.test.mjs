import assert from 'node:assert/strict';
import test from 'node:test';
import { ProgressTracker, progressReporterFromExtra, progressHeartbeatMs } from '../dist/lib/progress.js';
import { CommandExecutionError, runCommand } from '../dist/lib/runCommand.js';
import { harvestFailureDetail, stripHarvestProgressLines } from '../dist/tools/harvestKeynotePdf.js';

test('progressReporterFromExtra requires a progress token and a sender', () => {
  assert.equal(progressReporterFromExtra(undefined), undefined);
  assert.equal(progressReporterFromExtra({ sendNotification: async () => {} }), undefined);
  assert.equal(progressReporterFromExtra({ _meta: { progressToken: 'token-1' } }), undefined);

  const sent = [];
  const reporter = progressReporterFromExtra({
    _meta: { progressToken: 'token-1' },
    sendNotification: async (notification) => {
      sent.push(notification);
    },
  });
  assert.ok(reporter);
  reporter({ progress: 3, total: 10, message: 'page 3' });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    method: 'notifications/progress',
    params: { progressToken: 'token-1', progress: 3, total: 10, message: 'page 3' },
  });
});

test('progress reporting failures never propagate to the tool call', () => {
  const reporter = progressReporterFromExtra({
    _meta: { progressToken: 7 },
    sendNotification: async () => {
      throw new Error('host went away');
    },
  });
  assert.doesNotThrow(() => reporter({ progress: 1 }));
});

test('ProgressTracker keeps progress monotonically increasing across steps and heartbeats', () => {
  const updates = [];
  const tracker = new ProgressTracker((update) => updates.push(update));

  tracker.heartbeat('starting');
  tracker.step(1, 5, 'page 1');
  tracker.heartbeat('still going');
  tracker.step(1, 5, 'duplicate page 1 must be dropped');
  tracker.step(2, 5, 'page 2');

  const values = updates.map((update) => update.progress);
  assert.equal(values.length, 4);
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i] > values[i - 1], `progress must increase: ${values.join(', ')}`);
  }
  assert.deepEqual(updates[1], { progress: 1, total: 5, message: 'page 1' });
});

test('startHeartbeat emits on the configured interval until stopped', async () => {
  const previous = process.env.KEYNOTE_HARVEST_PROGRESS_HEARTBEAT_MS;
  process.env.KEYNOTE_HARVEST_PROGRESS_HEARTBEAT_MS = '100';
  try {
    assert.equal(progressHeartbeatMs(), 100);
    const updates = [];
    const tracker = new ProgressTracker((update) => updates.push(update));
    const stop = tracker.startHeartbeat('working');
    await new Promise((resolve) => setTimeout(resolve, 380));
    stop();
    const countAtStop = updates.length;
    assert.ok(countAtStop >= 2, `expected at least 2 heartbeats, saw ${countAtStop}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(updates.length, countAtStop, 'heartbeats must stop after stop()');
  } finally {
    if (previous === undefined) delete process.env.KEYNOTE_HARVEST_PROGRESS_HEARTBEAT_MS;
    else process.env.KEYNOTE_HARVEST_PROGRESS_HEARTBEAT_MS = previous;
  }
});

test('runCommand delivers stderr lines to onStderrLine as they arrive', async () => {
  const lines = [];
  const script =
    "process.stderr.write('one\\n'); setTimeout(() => { process.stderr.write('two\\npartial-'); setTimeout(() => { process.stderr.write('three\\n'); }, 40); }, 40);";
  await runCommand(process.execPath, ['-e', script], {
    onStderrLine: (line) => lines.push(line),
  });
  assert.deepEqual(lines, ['one', 'two', 'partial-three']);
});

test('oversized stderr lines are never delivered to onStderrLine', async () => {
  const lines = [];
  const script =
    "process.stderr.write('x'.repeat(100 * 1024) + '\\n'); setTimeout(() => process.stderr.write('after\\n'), 30);";
  await runCommand(process.execPath, ['-e', script], {
    onStderrLine: (line) => lines.push(line),
  });
  assert.deepEqual(lines, ['after']);
});

test('line buffering stops once the command-output limit is exceeded', async () => {
  const previous = process.env.KEYNOTE_HARVEST_MAX_COMMAND_OUTPUT_BYTES;
  process.env.KEYNOTE_HARVEST_MAX_COMMAND_OUTPUT_BYTES = '1024';
  try {
    const lines = [];
    const script =
      "process.stderr.write('early\\n'); setTimeout(() => { for (let i = 0; i < 200; i += 1) process.stderr.write('late-' + i + ' ' + 'y'.repeat(512) + '\\n'); setTimeout(() => {}, 500); }, 30);";
    await assert.rejects(
      runCommand(process.execPath, ['-e', script], {
        onStderrLine: (line) => lines.push(line),
      }),
      /command-output limit/
    );
    assert.ok(lines.every((line) => line.length <= 8192), 'no delivered line may exceed the buffer bound');
    assert.ok(
      lines.filter((line) => line.startsWith('late-')).length <= 3,
      `line delivery must stop at the output limit; delivered ${lines.length} lines`
    );
  } finally {
    if (previous === undefined) delete process.env.KEYNOTE_HARVEST_MAX_COMMAND_OUTPUT_BYTES;
    else process.env.KEYNOTE_HARVEST_MAX_COMMAND_OUTPUT_BYTES = previous;
  }
});

test('progress records are stripped from harvest diagnostics', () => {
  const mixed =
    'KEYNOTE_HARVEST_PROGRESS {"page":0,"total":3}\npdftoppm warning: odd font\nKEYNOTE_HARVEST_PROGRESS {"page":1,"total":3}\n';
  assert.equal(stripHarvestProgressLines(mixed), 'pdftoppm warning: odd font');
  assert.equal(stripHarvestProgressLines('KEYNOTE_HARVEST_PROGRESS {"page":1,"total":3}\n'), '');
});

test('harvest failures keep the underlying error when stderr held only progress records', () => {
  const timeout = new CommandExecutionError({
    message: 'Command "node" timed out after 5ms.',
    stdout: '',
    stderr: 'KEYNOTE_HARVEST_PROGRESS {"page":4,"total":40}\n',
    timedOut: true,
  });
  assert.equal(harvestFailureDetail(timeout), 'Command "node" timed out after 5ms.');

  const timeoutWithDetail = new CommandExecutionError({
    message: 'Command "node" timed out after 5ms.',
    stdout: '',
    stderr: 'KEYNOTE_HARVEST_PROGRESS {"page":4,"total":40}\npdftoppm stalled on page 5\n',
    timedOut: true,
  });
  assert.equal(harvestFailureDetail(timeoutWithDetail), 'Command "node" timed out after 5ms. pdftoppm stalled on page 5');

  const plainFailure = new CommandExecutionError({
    message: 'Command "node" failed with exit 1.',
    stdout: '',
    stderr: 'KEYNOTE_HARVEST_PROGRESS {"page":1,"total":2}\nInvalid PDF structure.\n',
  });
  assert.equal(harvestFailureDetail(plainFailure), 'Invalid PDF structure.');
});

test('an onStderrLine callback that throws does not fail the command', async () => {
  const result = await runCommand(process.execPath, ['-e', "process.stderr.write('boom\\n'); process.stdout.write('ok');"], {
    onStderrLine: () => {
      throw new Error('listener bug');
    },
  });
  assert.equal(result.stdout, 'ok');
});
