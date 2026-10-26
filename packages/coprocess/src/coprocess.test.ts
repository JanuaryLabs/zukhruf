import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Coprocess } from './coprocess.ts';

// A real child process: it answers each JSON line with the value it got, or
// with three lines for {"many":true}, and obeys a few commands.
const script = `
const lines = require('node:readline').createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const value = JSON.parse(line);
  if (value.exit !== undefined) {
    process.stderr.write(value.stderr ?? '');
    process.exit(value.exit);
  }
  if (value.garbage) return process.stdout.write('not json\\n');
  if (value.hang) return;
  if (value.many) {
    for (const step of [1, 2, 3]) process.stdout.write(JSON.stringify({ step }) + '\\n');
    return;
  }
  process.stdout.write(JSON.stringify({ echo: value }) + '\\n');
});
if (process.argv.includes('--ignore-sigterm')) process.on('SIGTERM', () => {});
`;

function echo(...flags: string[]) {
  return new Coprocess(process.execPath, ['-e', script, '--', ...flags], {
    name: 'Echo',
  });
}

describe('Coprocess', () => {
  test(
    'a request gets the value that answers it, in order, from one process',
    { timeout: 10_000 },
    async () => {
      // Arrange
      const process = echo();
      try {
        // Act
        const first = await process.request({ n: 1 });
        const second = await process.request({ n: 2 });

        // Assert
        assert.deepEqual(
          [first, second],
          [{ echo: { n: 1 } }, { echo: { n: 2 } }],
        );
      } finally {
        await process.close();
      }
    },
  );

  test(
    'a caller can receive many values for one it sent',
    { timeout: 10_000 },
    async () => {
      // Arrange
      const process = echo();
      try {
        // Act
        process.send({ many: true });
        const steps = [
          await process.receive(),
          await process.receive(),
          await process.receive(),
        ];

        // Assert
        assert.deepEqual(steps, [{ step: 1 }, { step: 2 }, { step: 3 }]);
      } finally {
        await process.close();
      }
    },
  );

  test(
    'an exit fails the receive that waits, with the name, the exit code and the end of stderr',
    { timeout: 10_000 },
    async () => {
      // Arrange
      const process = echo();
      const stderr = `${'x'.repeat(40_000)}the cause`;

      // Act
      const waiting = process.request({ exit: 3, stderr });

      // Assert
      await assert.rejects(waiting, (error: Error) => {
        assert.match(error.message, /^Echo exited \(3\): x+the cause$/);
        assert.ok(error.message.length < 17_000, 'stderr is kept to its tail');
        return true;
      });
      assert.match((await process.exited()).message, /^Echo exited \(3\)/);
      await assert.rejects(process.receive(), /^Error: Echo exited \(3\)/);
      process.send({ after: 'exit' });
    },
  );

  test(
    'kill stops a process that exits on SIGTERM at once',
    { timeout: 10_000 },
    async () => {
      // Arrange
      const process = echo();
      const waiting = process.request({ hang: true });

      // Act
      const started = performance.now();
      process.kill();

      // Assert
      await assert.rejects(waiting, /^Error: Echo exited \(SIGTERM\)/);
      assert.ok(performance.now() - started < 2_000);
    },
  );

  test(
    'kill sends SIGKILL when the process is still alive five seconds after SIGTERM',
    { timeout: 15_000 },
    async () => {
      // Arrange
      const process = echo('--ignore-sigterm');
      assert.deepEqual(await process.request({ n: 1 }), { echo: { n: 1 } });
      const waiting = process.request({ hang: true });

      // Act
      const started = performance.now();
      process.kill();

      // Assert
      await assert.rejects(waiting, /^Error: Echo exited \(SIGKILL\)/);
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 4_500 && elapsed < 8_000, `took ${elapsed} ms`);
    },
  );

  test(
    'close ends stdin and waits for the process to exit',
    { timeout: 10_000 },
    async () => {
      // Arrange
      const process = echo();
      await process.request({ n: 1 });

      // Act
      await process.close();

      // Assert
      assert.match((await process.exited()).message, /^Echo exited \(0\)/);
    },
  );

  test(
    'a line that is not JSON fails its receive',
    { timeout: 10_000 },
    async () => {
      // Arrange
      const process = echo();
      try {
        // Act
        const waiting = process.request({ garbage: true });

        // Assert
        await assert.rejects(
          waiting,
          /^Error: Echo gave a line that is not JSON/,
        );
      } finally {
        await process.close();
      }
    },
  );

  test(
    'a process that cannot start has exited, and a receive says it could not start',
    { timeout: 10_000 },
    async () => {
      // Arrange
      const process = new Coprocess('/no/such/helper', [], {
        name: 'Missing',
      });

      // Act
      const waiting = process.request({ n: 1 });

      // Assert
      await assert.rejects(waiting, /^Error: Missing could not start/);
      assert.match(
        (await process.exited()).message,
        /^Missing could not start/,
      );
    },
  );
});
