import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate as afterPendingReactions } from 'node:timers/promises';

import { Latch } from './latch.ts';

describe('Latch', () => {
  test(
    'a wait ends only when the latch opens',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const latch = new Latch();
      const ended: string[] = [];
      void latch.wait().then(() => ended.push('ended'));
      await afterPendingReactions();
      const beforeOpen = [...ended];

      // Act
      latch.open();
      await latch.wait();

      // Assert
      assert.deepEqual(beforeOpen, [], 'A closed latch must hold its waiters');
      assert.deepEqual(
        ended,
        ['ended'],
        'The wait must end when the latch opens',
      );
    },
  );

  test(
    'a wait that started before the latch opened gets the value it opened with',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const latch = new Latch<string>();
      const waiting = latch.wait();

      // Act
      latch.open('report');

      // Assert
      assert.equal(await waiting, 'report');
    },
  );

  test(
    'a wait that starts after the latch opened ends at once with the same value, also after a second open',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const latch = new Latch<string>();
      latch.open('first');

      // Act
      latch.open('second');
      const value = await latch.wait();

      // Assert
      assert.equal(
        value,
        'first',
        'An open latch must keep the value it opened with',
      );
    },
  );

  test('a latch whose type names a promise refuses one', async () => {
    // Arrange
    const empty = new Latch();
    const counter = new Latch<number>();
    const either = new Latch<Promise<number> | number>();
    // Only the type checker refuses these calls, so they go to latches nobody waits for.
    const promised = new Latch<Promise<number>>();
    const thenable = new Latch<PromiseLike<number>>();
    const promisedEither = new Latch<Promise<number> | number>();

    // Act
    empty.open();
    counter.open(1);
    either.open(2);
    // @ts-expect-error a latch would adopt the promise, and could then reject
    promised.open(Promise.resolve(1));
    // @ts-expect-error a latch would adopt the thenable, and could then reject
    thenable.open(Promise.resolve(1));
    // @ts-expect-error the promise in a union is refused too
    promisedEither.open(Promise.resolve(1));

    // Assert
    assert.deepEqual(
      await Promise.all([empty.wait(), counter.wait(), either.wait()]),
      [undefined, 1, 2],
    );
  });

  test(
    'a latch never holds a rejection, also when its type lets a failing promise in',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const unhandled: unknown[] = [];
      const record = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', record);
      try {
        const failing = Promise.reject(new Error('work failed'));
        // The caller handles its own promise; only the latch could leave one unhandled.
        void failing.catch(() => {});
        const latch = new Latch<unknown>();

        // Act
        latch.open(failing);
        await afterPendingReactions();

        // Assert
        assert.deepEqual(
          unhandled,
          [],
          'A latch must not hold a rejection that nobody awaits',
        );
      } finally {
        process.off('unhandledRejection', record);
      }
    },
  );
});
