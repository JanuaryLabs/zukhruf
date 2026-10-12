import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, test } from 'node:test';
import { setImmediate as afterPendingReactions } from 'node:timers/promises';
import { promisify } from 'node:util';

import { poll } from './poll.ts';

const execFileAsync = promisify(execFile);

describe('poll', () => {
  test(
    'a deadline that already passed still gets exactly one attempt, and the poll then resolves undefined without a wait',
    { timeout: 2_000 },
    async () => {
      // Arrange
      let attempts = 0;
      const deadline = performance.now();

      // Act
      const started = performance.now();
      const value = await poll(
        async () => {
          attempts++;
          return undefined;
        },
        { interval: 1_000, signal: undefined, deadline },
      );
      const elapsed = performance.now() - started;

      // Assert
      assert.equal(value, undefined);
      assert.equal(
        attempts,
        1,
        'A campaign with a timeout of 0 must try the claim once',
      );
      assert.ok(
        elapsed < 500,
        `The poll must not wait after the last attempt, but it took ${elapsed} ms`,
      );
    },
  );

  test(
    'an attempt that gives a value after the deadline passed still resolves the poll with that value',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const deadline = performance.now() - 1;

      // Act
      const value = await poll(async () => 'held', {
        interval: 1_000,
        signal: undefined,
        deadline,
      });

      // Assert
      assert.equal(
        value,
        'held',
        'A campaign with a timeout of 0 that wins its one try must get its term',
      );
    },
  );

  test(
    'an error from an attempt rejects the poll with that same error, and no attempt follows',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const failure = new Error('disk full');
      let attempts = 0;

      // Act
      const polling = poll(
        async () => {
          attempts++;
          throw failure;
        },
        { interval: 5, signal: undefined },
      );

      // Assert
      await assert.rejects(polling, (error) => error === failure);
      assert.equal(attempts, 1, 'A failed attempt must not be tried again');
    },
  );

  test(
    'an abort during the wait rejects the poll with the reason of the signal, and no attempt follows',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const controller = new AbortController();
      const reason = new Error('the caller left');
      let attempts = 0;
      const polling = poll(
        async () => {
          attempts++;
          return undefined;
        },
        { interval: 60_000, signal: controller.signal },
      );
      const rejected = assert.rejects(polling, (error) => error === reason);
      await afterPendingReactions();

      // Act
      controller.abort(reason);

      // Assert
      await rejected;
      assert.equal(attempts, 1);
    },
  );

  test(
    'a process that cancels a poll during its wait ends at once, because the timer of the wait stops',
    { timeout: 10_000 },
    async () => {
      // Arrange
      const program = `
        import { poll } from ${JSON.stringify(import.meta.resolve('./poll.ts'))};
        const controller = new AbortController();
        const polling = poll(async () => undefined, {
          interval: 60_000,
          signal: controller.signal,
        });
        setImmediate(() => controller.abort(new Error('the caller left')));
        await polling.catch(() => {});
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
        'The process must end when the poll is cancelled, not after the interval of 60 seconds',
      );
    },
  );

  test(
    'the first attempt occurs at once, attempts that give nothing repeat after the interval, and the poll resolves with the first value that is not undefined',
    { timeout: 5_000 },
    async () => {
      // Arrange
      const interval = 200;
      const times: number[] = [];
      const answers = [undefined, undefined, null];

      // Act
      const started = performance.now();
      const value = await poll(
        async () => {
          times.push(performance.now());
          return answers[times.length - 1];
        },
        { interval, signal: undefined },
      );

      // Assert
      assert.equal(
        value,
        null,
        'Only undefined means that an attempt gave nothing',
      );
      assert.equal(times.length, 3);
      assert.ok(
        times[0]! - started < interval - 2,
        'The first attempt must not wait for the interval',
      );
      for (let index = 1; index < times.length; index++) {
        const gap = times[index]! - times[index - 1]!;
        assert.ok(
          gap >= interval - 2 && gap < interval + 500,
          `Attempt ${index + 1} came ${gap} ms after the one before it, not after the interval of ${interval} ms`,
        );
      }
    },
  );

  test(
    'with a deadline, attempts that give nothing repeat until the deadline passes, and the poll then resolves undefined',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const started = performance.now();
      const deadline = started + 50;
      let attempts = 0;

      // Act
      const value = await poll(
        async () => {
          attempts++;
          return undefined;
        },
        { interval: 10, signal: undefined, deadline },
      );
      const elapsed = performance.now() - started;

      // Assert
      assert.equal(value, undefined);
      assert.ok(attempts > 1, 'The poll must try again before the deadline');
      assert.ok(
        elapsed >= 50 && elapsed < 50 + 10 + 500,
        `The poll must stop at the first attempt after the deadline, but it stopped after ${elapsed} ms`,
      );
    },
  );
});
