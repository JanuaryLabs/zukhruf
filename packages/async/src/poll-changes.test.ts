import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';

import { createClock } from '@sinonjs/fake-timers';

import { pollChanges } from './poll-changes.ts';

const execFileAsync = promisify(execFile);

describe('pollChanges', () => {
  test(
    'an abort during the wait ends the iteration with no error, stops the timer, and no read follows',
    { timeout: 2_000 },
    async (t) => {
      // Arrange
      const clock = createClock();
      const controller = new AbortController();
      let reads = 0;
      const checks = pollChanges(
        async () => {
          reads++;
          return new Map([['store', 1]]);
        },
        { interval: 60_000, signal: controller.signal, clock },
      );
      await checks.next();
      const next = checks.next();
      await t.waitFor(() => assert.equal(clock.countTimers(), 1));

      // Act
      controller.abort(new Error('the watch stopped'));

      // Assert
      assert.deepEqual(
        await next,
        { done: true, value: undefined },
        'An elt source ends its watch on an abort, as its loop does today',
      );
      assert.equal(clock.countTimers(), 0, 'The abort must stop the timer');
      await clock.tickAsync(60_000);
      assert.equal(reads, 1);
    },
  );

  test(
    'a signal that aborted before the call ends the iteration before the first read',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const clock = createClock();
      let reads = 0;
      const signal = AbortSignal.abort();

      // Act
      const checks = await Array.fromAsync(
        pollChanges(
          async () => {
            reads++;
            return new Map([['store', 1]]);
          },
          { interval: 5, signal, clock },
        ),
      );

      // Assert
      assert.deepEqual(checks, []);
      assert.equal(reads, 0, 'A stopped watch must not read the store');
      assert.equal(clock.countTimers(), 0);
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
        const checks = pollChanges(async () => new Map([['store', 1]]), {
          interval: 60_000,
          signal: controller.signal,
          clock: globalThis,
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
      const clock = createClock();
      const failure = new Error('database is locked');
      let reads = 0;
      const checks = pollChanges(
        async () => {
          if (++reads === 2) throw failure;
          return new Map([['store', 1]]);
        },
        { interval: 5, signal: new AbortController().signal, clock },
      );
      await checks.next();

      // Act
      const next = checks.next();
      const rejected = assert.rejects(next, (error) => error === failure);
      await clock.tickAsync(5);

      // Assert
      await rejected;
    },
  );

  test(
    'the first check reads at once and yields every key, a later check yields only the keys whose value changed, a check with no change yields an empty set, and each check reads one time for all keys',
    { timeout: 2_000 },
    async (t) => {
      // Arrange
      const clock = createClock();
      const interval = 5;
      const books = [1, 1, 2, 2];
      const notes = ['a', 'b', 'b', 'b'];
      let reads = 0;
      const checks = pollChanges(
        async () => {
          const check = reads++;
          return new Map<string, unknown>([
            ['books', books[check]],
            ['notes', notes[check]],
          ]);
        },
        { interval, signal: new AbortController().signal, clock },
      );

      // Act
      const firstCheck = checks.next();
      await t.waitFor(() =>
        assert.equal(reads, 1, 'The first check must read before any wait'),
      );
      assert.equal(clock.countTimers(), 0);
      const first = await firstCheck;
      const later: (readonly string[])[] = [];
      for (let check = 1; check < books.length; check++) {
        const next = checks.next();
        await clock.tickAsync(interval);
        const result = await next;
        if (result.done) assert.fail(`The watch ended at check ${check + 1}`);
        later.push([...result.value]);
      }

      // Assert
      if (first.done) assert.fail('The watch ended before its first check');
      assert.deepEqual(
        [...first.value],
        ['books', 'notes'],
        'The first check must yield every key, before any wait',
      );
      assert.equal(clock.now, (books.length - 1) * interval);
      assert.deepEqual(later, [['notes'], ['books'], []]);
      assert.equal(
        reads,
        books.length,
        'One read must give the values of all keys of a check, as one query of a database gives many values',
      );
    },
  );

  test(
    'a key that a check gives and the previous check did not give, or that the previous check gave and this check does not give, changed',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const clock = createClock();
      const interval = 5;
      const snapshots = [
        new Map([['books', 1]]),
        new Map([
          ['books', 1],
          ['notes', 1],
        ]),
        new Map([['notes', 1]]),
      ];
      let reads = 0;
      const checks = pollChanges(
        async () => {
          const snapshot = snapshots[reads++];
          if (snapshot === undefined)
            assert.fail('A check read past the last snapshot');
          return snapshot;
        },
        { interval, signal: new AbortController().signal, clock },
      );
      await checks.next();

      // Act
      const later: (readonly string[])[] = [];
      for (let check = 1; check < snapshots.length; check++) {
        const next = checks.next();
        await clock.tickAsync(interval);
        const result = await next;
        if (result.done) assert.fail(`The watch ended at check ${check + 1}`);
        later.push([...result.value]);
      }

      // Assert
      assert.deepEqual(
        later,
        [['notes'], ['books']],
        'A table that appears or is dropped between two checks must wake its consumer',
      );
    },
  );

  test(
    'after a slow consumer, the next check still waits the full interval from when the consumer asks',
    { timeout: 5_000 },
    async () => {
      // Arrange
      const clock = createClock();
      const interval = 200;
      const times: number[] = [];
      const checks = pollChanges(
        async () => {
          times.push(clock.now);
          return new Map([['store', times.length]]);
        },
        { interval, signal: new AbortController().signal, clock },
      );
      await checks.next();

      // Act
      for (let slow = 0; slow < 2; slow++) {
        await clock.tickAsync(interval * 2);
        const next = checks.next();
        await clock.tickAsync(interval - 1);
        const early = times.length;
        await clock.tickAsync(1);
        await next;
        assert.equal(
          times.length,
          early + 1,
          'The check must come one full interval after the consumer asks, not before',
        );
      }

      // Assert
      assert.deepEqual(times, [0, interval * 3, interval * 6]);
    },
  );
});
