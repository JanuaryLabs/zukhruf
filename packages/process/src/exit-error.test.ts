import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Command, ExitError } from './index.ts';

const node = (source: string) =>
  new Command(process.execPath, ['-e', source], {
    clock: globalThis,
    env: {},
  });

test('an ExitError names the process and the end and has the stderr', async () => {
  // Arrange
  const run = await node(
    "process.stderr.write('no such key'); process.exit(3);",
  ).run();

  // Act
  const error = new ExitError('vault', run);

  // Assert
  assert.deepEqual(
    { message: error.message, end: error.end, stderr: error.stderr },
    {
      message: 'vault ended (exit code 3): no such key',
      end: { exitCode: 3 },
      stderr: 'no such key',
    },
  );
});

test('an ExitError of a run that a signal ended names the signal', async () => {
  // Arrange
  const run = await node("process.kill(process.pid, 'SIGKILL');").run();

  // Act
  const error = new ExitError('worker', run);

  // Assert
  assert.deepEqual(
    { message: error.message, end: error.end },
    { message: 'worker ended (SIGKILL)', end: { signal: 'SIGKILL' } },
  );
});

test('an ExitError keeps the last 16 KiB of the stderr, as a ProcessEndedError does', async () => {
  // Arrange
  const run = await node(
    "process.stderr.write('a'.repeat(20 * 1024) + 'the end'); process.exit(1);",
  ).run();

  // Act
  const error = new ExitError('tool', run);

  // Assert
  assert.deepEqual(
    { length: error.stderr.length, last: error.stderr.endsWith('the end') },
    { length: 16 * 1024, last: true },
  );
});

test('an ExitError of a started process with only its end has no stderr in its message', async (t) => {
  // Arrange: the stderr goes to this program, so the end is all there is.
  const started = await node('process.exit(5);').start({
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'inherit',
    signal: t.signal,
  });
  const end = await started.ended;

  // Act
  const error = new ExitError('installer', end);

  // Assert
  assert.deepEqual(
    { message: error.message, end: error.end, stderr: error.stderr },
    {
      message: 'installer ended (exit code 5)',
      end: { exitCode: 5 },
      stderr: '',
    },
  );
});
