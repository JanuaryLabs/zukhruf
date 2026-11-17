import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate as afterPendingReactions } from 'node:timers/promises';

import { Lock } from './lock.ts';

describe('Lock', () => {
  test('one caller holds the lock at a time', async () => {
    // Arrange
    const lock = new Lock();
    const holder = await lock.acquire({ signal: undefined });

    // Act
    const whileHeld = lock.tryAcquire();
    holder[Symbol.dispose]();
    const afterDispose = lock.tryAcquire();

    // Assert
    assert.equal(whileHeld, undefined);
    assert.ok(afterDispose, 'A disposed lock must be free');
  });

  test('runs work one at a time, in the order of the calls', async () => {
    // Arrange
    const lock = new Lock();
    const events: string[] = [];
    const firstWork = Promise.withResolvers<void>();

    // Act
    const runs = [
      lock.run(
        async () => {
          events.push('first starts');
          await firstWork.promise;
          events.push('first ends');
        },
        { signal: undefined },
      ),
      lock.run(
        async () => {
          events.push('second starts');
        },
        { signal: undefined },
      ),
      lock.run(
        async () => {
          events.push('third starts');
        },
        { signal: undefined },
      ),
    ];
    await afterPendingReactions();
    const whileFirstRuns = [...events];
    firstWork.resolve();
    await Promise.all(runs);

    // Assert
    assert.deepEqual(whileFirstRuns, ['first starts']);
    assert.deepEqual(events, [
      'first starts',
      'first ends',
      'second starts',
      'third starts',
    ]);
  });

  test('a run whose work fails rejects with its error and frees the lock for the next run', async () => {
    // Arrange
    const lock = new Lock();
    const failure = new Error('work failed');

    // Act
    const failed = lock.run(
      async () => {
        throw failure;
      },
      { signal: undefined },
    );
    const rejected = assert.rejects(failed, (error) => error === failure);
    const ended: string[] = [];
    const next = lock
      .run(async () => 'report', { signal: undefined })
      .then((value) => ended.push(value));
    await afterPendingReactions();

    // Assert
    await rejected;
    assert.deepEqual(ended, ['report'], 'The next run must get the lock');
    await next;
  });

  test('a holder that acquires with using frees the lock at the end of its block', async () => {
    // Arrange
    const lock = new Lock();

    // Act
    {
      using held = await lock.acquire({ signal: undefined });
      assert.ok(held);
      assert.equal(lock.tryAcquire(), undefined);
    }

    // Assert
    assert.ok(lock.tryAcquire(), 'The lock must be free after the block');
  });

  test('a run that cancels while it waits rejects with the reason and never starts its work', async () => {
    // Arrange
    const lock = new Lock();
    const holder = lock.tryAcquire();
    assert.ok(holder);
    const controller = new AbortController();
    const reason = new Error('cancelled');
    let started = false;
    const cancelled = lock.run(
      async () => {
        started = true;
      },
      { signal: controller.signal },
    );
    const rejected = assert.rejects(cancelled, (error) => error === reason);

    // Act
    controller.abort(reason);
    await rejected;
    holder[Symbol.dispose]();
    await afterPendingReactions();

    // Assert
    assert.equal(started, false, 'A cancelled run must not start its work');
    assert.ok(lock.tryAcquire(), 'A cancelled run must not hold the lock');
  });
});
