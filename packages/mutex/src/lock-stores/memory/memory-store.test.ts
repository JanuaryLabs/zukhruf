import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { settle } from '../../testing/store-cases.ts';
import { waitUntil } from '../../testing/wait-until.ts';
import { watch } from '../../testing/watch.ts';
import { MemoryStore } from './memory-store.ts';

describe('MemoryStore', () => {
  test('waiters get the key in the order they asked for it', async () => {
    // Arrange: a holder, and three waiters that release as soon as they get the key.
    const store = new MemoryStore();
    const holder = await store.acquire('product:42');
    const granted: string[] = [];
    const waiters = ['first', 'second', 'third'].map((name) =>
      store.acquire('product:42').then(async (lease) => {
        granted.push(name);
        await lease[Symbol.asyncDispose]();
      }),
    );

    // Act
    await holder[Symbol.asyncDispose]();
    await Promise.all(waiters);

    // Assert
    assert.deepEqual(granted, ['first', 'second', 'third']);
  });

  test('a waiter that gives up in the middle of the line does not let the waiter behind it in early', async (t) => {
    // Arrange: a holder, then a waiter, a waiter that will give up, and a last waiter.
    const store = new MemoryStore();
    const holder = await store.acquire('product:42');
    const first = store.acquire('product:42');
    const giveUp = new AbortController();
    const quitter = store.acquire('product:42', { signal: giveUp.signal });
    const last = watch(store.acquire('product:42'));

    // Act: the middle waiter gives up, then the holder and the first waiter release in turn.
    giveUp.abort();
    await assert.rejects(quitter, { name: 'AbortError' });
    await delay(settle);
    const lastAfterGiveUp = last.now.status;
    await holder[Symbol.asyncDispose]();
    const firstLease = await first;
    await delay(settle);
    const lastWhileFirstHolds = last.now.status;
    await firstLease[Symbol.asyncDispose]();

    // Assert
    assert.equal(
      lastAfterGiveUp,
      'pending',
      'A waiter that gives up must not hand the key on before its turn',
    );
    assert.equal(
      lastWhileFirstHolds,
      'pending',
      'The last waiter must wait for the first waiter',
    );
    await waitUntil(
      t,
      () => last.now.status === 'fulfilled',
      'The last waiter must get the key once the first releases',
    );
  });

  test('a try is busy while the key is held and succeeds after the release', async () => {
    // Arrange
    const store = new MemoryStore();
    const holder = await store.acquire('product:42');

    // Act
    const whileHeld = await store.tryAcquire('product:42');
    await holder[Symbol.asyncDispose]();
    const afterRelease = await store.tryAcquire('product:42');

    // Assert
    assert.equal(whileHeld, undefined, 'A held key must be busy');
    assert.ok(afterRelease, 'A released key must be free');
  });

  test('a key leaves nothing behind once its line is empty, also when the last waiter gave up', async () => {
    // Arrange: a holder, a waiter, and a last waiter that gives up.
    const store = new MemoryStore();
    const holder = await store.acquire('product:42');
    const waiter = store.acquire('product:42');
    const giveUp = new AbortController();
    const quitter = store.acquire('product:42', { signal: giveUp.signal });
    giveUp.abort();
    await assert.rejects(quitter, { name: 'AbortError' });

    // Act: everyone ahead of the waiter that gave up releases.
    await holder[Symbol.asyncDispose]();
    await (await waiter)[Symbol.asyncDispose]();
    await delay(0);

    // Assert
    assert.ok(
      await store.tryAcquire('product:42'),
      'The key must be free when no one holds or waits for it',
    );
  });

  test('an acquire that is already cancelled rejects at once with its reason and leaves the key free', async () => {
    // Arrange
    const store = new MemoryStore();
    const reason = new Error('The request was cancelled.');

    // Act
    const acquiring = store.acquire('product:42', {
      signal: AbortSignal.abort(reason),
    });

    // Assert
    await assert.rejects(acquiring, (error) => error === reason);
    assert.ok(
      await store.tryAcquire('product:42'),
      'A cancelled acquire must not hold the key',
    );
  });
});
