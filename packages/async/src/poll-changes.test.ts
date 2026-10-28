import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';

import { pollChanges } from './poll-changes.ts';

const execFileAsync = promisify(execFile);

describe('pollChanges', () => {
  test(
    'an abort during the wait ends the iteration with no error, and no read follows',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const controller = new AbortController();
      let reads = 0;
      const checks = pollChanges(
        new Map([
          [
            'store',
            async () => {
              reads++;
              return 1;
            },
          ],
        ]),
        { interval: 60_000, signal: controller.signal },
      );
      await checks.next();

      // Act
      const next = checks.next();
      controller.abort(new Error('the watch stopped'));

      // Assert
      assert.deepEqual(
        await next,
        { done: true, value: undefined },
        'An elt source ends its watch on an abort, as its loop does today',
      );
      assert.equal(reads, 1);
    },
  );

  test(
    'a signal that aborted before the call ends the iteration before the first read',
    { timeout: 2_000 },
    async () => {
      // Arrange
      let reads = 0;
      const signal = AbortSignal.abort();

      // Act
      const checks = await Array.fromAsync(
        pollChanges(
          new Map([
            [
              'store',
              async () => {
                reads++;
                return 1;
              },
            ],
          ]),
          { interval: 5, signal },
        ),
      );

      // Assert
      assert.deepEqual(checks, []);
      assert.equal(reads, 0, 'A stopped watch must not read the store');
    },
  );

  test(
    'a process that aborts a watch during its wait ends at once, because the timer of the wait stops',
    { timeout: 10_000 },
    async () => {
      // Arrange
      const program = `
        import { pollChanges } from ${JSON.stringify(import.meta.resolve('./poll-changes.ts'))};
        const controller = new AbortController();
        const checks = pollChanges(new Map([['store', async () => 1]]), {
          interval: 60_000,
          signal: controller.signal,
        });
        await checks.next();
        setImmediate(() => controller.abort());
        await checks.next();
      `;

      // Act
      const run = execFileAsync(
        process.execPath,
        ['--input-type=module', '--eval', program],
        { timeout: 5_000 },
      );

      // Assert
      await assert.doesNotReject(
        run,
        'The process must end when the watch is aborted, not after the interval of 60 seconds',
      );
    },
  );

  test(
    'an error from a read rejects the iteration with that same error',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const failure = new Error('database is locked');
      let reads = 0;
      const checks = pollChanges(
        new Map([
          [
            'store',
            async () => {
              if (++reads === 2) throw failure;
              return 1;
            },
          ],
        ]),
        { interval: 5, signal: new AbortController().signal },
      );
      await checks.next();

      // Act
      const next = checks.next();

      // Assert
      await assert.rejects(next, (error) => error === failure);
    },
  );

  test(
    'the first check reads at once and yields every key, a later check yields only the keys whose value changed, and a check with no change yields an empty set',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const controller = new AbortController();
      const books = [1, 1, 2, 2];
      const notes = ['a', 'b', 'b', 'b'];
      let bookReads = 0;
      let noteReads = 0;
      const started = performance.now();
      const checks = pollChanges(
        new Map<string, () => Promise<unknown>>([
          ['books', async () => books[bookReads++]],
          ['notes', async () => notes[noteReads++]],
        ]),
        { interval: 5, signal: controller.signal },
      );

      // Act
      const yielded: (readonly string[])[] = [];
      let firstAfter = 0;
      for await (const changed of checks) {
        if (yielded.length === 0) firstAfter = performance.now() - started;
        yielded.push([...changed]);
        if (yielded.length === books.length) controller.abort();
      }

      // Assert
      assert.deepEqual(yielded, [['books', 'notes'], ['notes'], ['books'], []]);
      assert.ok(
        firstAfter < 1_000,
        `The first check must not wait for an interval, but it came after ${firstAfter} ms`,
      );
    },
  );

  test(
    'after a slow consumer, the next check still waits the full interval',
    { timeout: 5_000 },
    async () => {
      // Arrange
      const interval = 200;
      const controller = new AbortController();
      const times: number[] = [];
      const checks = pollChanges(
        new Map([
          [
            'store',
            async () => {
              times.push(performance.now());
              return times.length;
            },
          ],
        ]),
        { interval, signal: controller.signal },
      );

      // Act
      for await (const _ of checks) {
        if (times.length === 3) {
          controller.abort();
          continue;
        }
        const busyUntil = performance.now() + interval * 2;
        while (performance.now() < busyUntil);
      }

      // Assert
      for (let index = 1; index < times.length; index++) {
        const gap = times[index]! - times[index - 1]!;
        assert.ok(
          gap >= interval * 3 - 5,
          `Read ${index + 1} came ${gap} ms after the one before it; a slow body of ${interval * 2} ms must be followed by a full wait of ${interval} ms`,
        );
      }
    },
  );
});
