import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate as afterPendingReactions } from 'node:timers/promises';

import { Future } from './future.ts';

describe('Future', () => {
  test('a failure that nobody waits for leaves no unhandled rejection', async () => {
    // Arrange
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
      const rejected = new Future<string>();

      // Act
      rejected.reject(new Error('work failed'));
      Future.run<string>(async () => {
        throw new Error('work failed');
      });
      await afterPendingReactions();

      // Assert
      assert.deepEqual(
        unhandled,
        [],
        'A future must keep its failure as data until a caller waits',
      );
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  test('a reject rejects each wait with the same reason, the waits that started before it and after it', async () => {
    // Arrange
    const future = new Future<string>();
    const reason = new Error('work failed');
    const early = future.wait();
    const earlyRejected = assert.rejects(early, (error) => error === reason);

    // Act
    future.reject(reason);
    await afterPendingReactions();
    const late = future.wait();

    // Assert
    await earlyRejected;
    await assert.rejects(late, (error) => error === reason);
    await assert.rejects(future.wait(), (error) => error === reason);
  });

  test('a resolve gives each wait the same value, the waits that started before it and after it', async () => {
    // Arrange
    const future = new Future<{ report: string }>();
    const value = { report: 'done' };
    const early = future.wait();

    // Act
    future.resolve(value);
    await afterPendingReactions();
    const late = future.wait();

    // Assert
    assert.equal(await early, value);
    assert.equal(await late, value);
  });

  test('the first settle wins, and a later resolve or reject changes nothing', async () => {
    // Arrange
    const resolvedFirst = new Future<string>();
    const rejectedFirst = new Future<string>();
    const reason = new Error('first failure');

    // Act
    resolvedFirst.resolve('first');
    resolvedFirst.reject(new Error('later failure'));
    resolvedFirst.resolve('later');
    rejectedFirst.reject(reason);
    rejectedFirst.resolve('later');
    rejectedFirst.reject(new Error('later failure'));

    // Assert
    assert.equal(await resolvedFirst.wait(), 'first');
    await assert.rejects(rejectedFirst.wait(), (error) => error === reason);
  });

  test('a future whose type names a promise refuses one', async () => {
    // Arrange
    const empty = new Future<void>();
    const counter = new Future<number>();
    // Only the type checker refuses these calls, so they go to futures nobody waits for.
    const promised = new Future<Promise<number>>();
    const thenable = new Future<PromiseLike<number>>();
    const promisedEither = new Future<Promise<number> | number>();

    // Act
    empty.resolve();
    counter.resolve(1);
    // @ts-expect-error a future would adopt the promise, and its value could then be a failure
    promised.resolve(Promise.resolve(1));
    // @ts-expect-error a future would adopt the thenable, and its value could then be a failure
    thenable.resolve(Promise.resolve(1));
    // @ts-expect-error the promise in a union is refused too
    promisedEither.resolve(Promise.resolve(1));

    // Assert
    assert.deepEqual(await Promise.all([empty.wait(), counter.wait()]), [
      undefined,
      1,
    ]);
  });

  test('run settles with the outcome of the work, and a work that throws at once fails as an async work does', async () => {
    // Arrange
    const reason = new Error('work failed');

    // Act
    const succeeded = Future.run(async () => 'report');
    const failed = Future.run<string>(async () => {
      throw reason;
    });
    const thrownAtOnce = Future.run<string>(() => {
      throw reason;
    });

    // Assert
    assert.equal(await succeeded.wait(), 'report');
    await assert.rejects(failed.wait(), (error) => error === reason);
    await assert.rejects(thrownAtOnce.wait(), (error) => error === reason);
  });
});
