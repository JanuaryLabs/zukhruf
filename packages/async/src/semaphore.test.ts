import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate as afterPendingReactions } from 'node:timers/promises';

import { Semaphore } from './semaphore.ts';

describe('Semaphore', () => {
  test('a waiter that cancels rejects with the reason of the signal and leaves the line, so the next waiter gets the permit', async () => {
    // Arrange
    const semaphore = new Semaphore(1);
    const holder = semaphore.tryAcquire();
    assert.ok(holder);
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const cancelled = semaphore.acquire({ signal: controller.signal });
    const rejected = assert.rejects(cancelled, (error) => error === reason);
    const granted: string[] = [];
    const next = semaphore.acquire({ signal: undefined }).then((permit) => {
      granted.push('next');
      return permit;
    });

    // Act
    controller.abort(reason);
    await rejected;
    holder[Symbol.dispose]();
    await afterPendingReactions();

    // Assert
    assert.deepEqual(granted, ['next'], 'The next waiter must get the permit');
    assert.equal(
      semaphore.tryAcquire(),
      undefined,
      'The next waiter must hold the one permit',
    );
    (await next)[Symbol.dispose]();
  });

  test('a signal that aborted before the call rejects with its reason and takes no permit, also when a permit is free', async () => {
    // Arrange
    const semaphore = new Semaphore(1);
    const reason = new Error('cancelled before the call');

    // Act
    const acquiring = semaphore.acquire({ signal: AbortSignal.abort(reason) });

    // Assert
    await assert.rejects(acquiring, (error) => error === reason);
    assert.ok(
      semaphore.tryAcquire(),
      'The permit must stay free after a call that was cancelled before it started',
    );
  });

  test('a second dispose of one permit frees nothing more', async () => {
    // Arrange
    const semaphore = new Semaphore(2);
    const first = semaphore.tryAcquire();
    const second = semaphore.tryAcquire();
    assert.ok(first && second);

    // Act
    first[Symbol.dispose]();
    first[Symbol.dispose]();

    // Assert
    assert.ok(semaphore.tryAcquire(), 'The first dispose must free a permit');
    assert.equal(
      semaphore.tryAcquire(),
      undefined,
      'The second dispose must not free a permit that another holder has',
    );
  });

  test('at most as many callers as there are permits hold one at the same time', async () => {
    // Arrange
    const semaphore = new Semaphore(2);
    const granted: number[] = [];

    // Act
    for (const caller of [1, 2, 3]) {
      void semaphore
        .acquire({ signal: undefined })
        .then(() => granted.push(caller));
    }
    await afterPendingReactions();

    // Assert
    assert.deepEqual(granted, [1, 2], 'The third caller must wait');
    assert.equal(semaphore.tryAcquire(), undefined);
  });

  test('a dispose gives the permit to the waiters in the order in which they came', async () => {
    // Arrange
    const semaphore = new Semaphore(1);
    const holder = semaphore.tryAcquire();
    assert.ok(holder);
    const granted: string[] = [];
    const permits: Disposable[] = [];
    for (const name of ['first', 'second', 'third']) {
      void semaphore.acquire({ signal: undefined }).then((permit) => {
        granted.push(name);
        permits.push(permit);
      });
    }
    await afterPendingReactions();
    const beforeDispose = [...granted];

    // Act
    const afterEachDispose: string[][] = [];
    holder[Symbol.dispose]();
    await afterPendingReactions();
    afterEachDispose.push([...granted]);
    for (let next = 0; next < 3; next++) {
      permits[next]?.[Symbol.dispose]();
      await afterPendingReactions();
      afterEachDispose.push([...granted]);
    }

    // Assert
    assert.deepEqual(beforeDispose, [], 'A held permit must hold its waiters');
    assert.deepEqual(afterEachDispose, [
      ['first'],
      ['first', 'second'],
      ['first', 'second', 'third'],
      ['first', 'second', 'third'],
    ]);
  });

  test('tryAcquire gives nothing while callers wait, also just after a holder disposed its permit', async () => {
    // Arrange
    const semaphore = new Semaphore(1);
    const holder = semaphore.tryAcquire();
    assert.ok(holder);
    const waiter = semaphore.acquire({ signal: undefined });
    const whileHeld = semaphore.tryAcquire();

    // Act
    holder[Symbol.dispose]();
    const afterDispose = semaphore.tryAcquire();

    // Assert
    assert.equal(whileHeld, undefined);
    assert.equal(
      afterDispose,
      undefined,
      'The freed permit must go to the waiter, not to a later tryAcquire',
    );
    (await waiter)[Symbol.dispose]();
    assert.ok(
      semaphore.tryAcquire(),
      'The permit must be free after the waiter disposed it',
    );
  });

  test('a cancel that comes at the moment the waiter gets the permit passes the permit on', async () => {
    // Arrange
    const semaphore = new Semaphore(1);
    const holder = semaphore.tryAcquire();
    assert.ok(holder);
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const cancelled = semaphore.acquire({ signal: controller.signal });
    const rejected = assert.rejects(cancelled, (error) => error === reason);
    const granted: string[] = [];
    const next = semaphore.acquire({ signal: undefined }).then((permit) => {
      granted.push('next');
      return permit;
    });

    // Act
    holder[Symbol.dispose]();
    controller.abort(reason);
    await afterPendingReactions();

    // Assert
    await rejected;
    assert.deepEqual(
      granted,
      ['next'],
      'The permit must pass on to the next waiter',
    );
    const permit = await next;
    assert.equal(
      semaphore.tryAcquire(),
      undefined,
      'The next waiter must hold the one permit',
    );
    permit[Symbol.dispose]();
    assert.ok(semaphore.tryAcquire(), 'The permit must be free again');
    assert.equal(
      semaphore.tryAcquire(),
      undefined,
      'The cancel must not add a permit',
    );
  });

  test('a count of permits that is not a positive integer is refused', () => {
    // Arrange
    const counts = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

    // Act
    const refused = counts.filter((count) => {
      try {
        new Semaphore(count);
        return false;
      } catch (error) {
        return error instanceof RangeError;
      }
    });

    // Assert
    assert.deepEqual(refused, counts);
  });
});
