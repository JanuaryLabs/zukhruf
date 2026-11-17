import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryStore } from './memory-store.ts';

describe('MemoryStore cancel', () => {
  test('a key whose only waiter cancelled is free in the same turn that its holder releases it', async () => {
    // Arrange: a holder, and a waiter that cancels.
    const store = new MemoryStore();
    const holder = await store.acquire('product:42');
    const cancel = new AbortController();
    const quitter = store.acquire('product:42', { signal: cancel.signal });
    cancel.abort();
    await assert.rejects(quitter, { name: 'AbortError' });

    // Act: a look and a try in the same turn as the release, as a coordinator reads them from one chunk.
    const releasing = holder[Symbol.asyncDispose]();
    const heldAfterRelease = store.isHeld('product:42');
    const anyKeyAfterRelease = store.holdsAnyKey;
    const tryAfterRelease = store.tryAcquire('product:42');
    await releasing;

    // Assert
    assert.equal(
      await heldAfterRelease,
      false,
      'A cancelled waiter must not keep a place in the line',
    );
    assert.ok(
      await tryAfterRelease,
      'The next caller must get the key at once',
    );
    assert.equal(anyKeyAfterRelease, false);
  });

  test('a waiter that cancels in the middle of the line leaves it, and the release gives the key to the waiter behind it', async () => {
    // Arrange: a holder, a waiter that cancels, and a waiter behind it.
    const store = new MemoryStore();
    const holder = await store.acquire('product:42');
    const cancel = new AbortController();
    const quitter = store.acquire('product:42', { signal: cancel.signal });
    const next = store.acquire('product:42');
    cancel.abort();
    await assert.rejects(quitter, { name: 'AbortError' });

    // Act: a newcomer tries in the same turn as the release.
    const releasing = holder[Symbol.asyncDispose]();
    const newcomer = await store.tryAcquire('product:42');
    await releasing;
    const nextLease = await next;
    const heldByNext = await store.isHeld('product:42');
    await nextLease[Symbol.asyncDispose]();

    // Assert
    assert.equal(
      newcomer,
      undefined,
      'The key must go to the waiter in the line, not to a newcomer',
    );
    assert.equal(heldByNext, true);
    assert.equal(await store.isHeld('product:42'), false);
  });

  test('the waiters get the key in the order in which they came when a waiter between them cancels', async () => {
    // Arrange: a holder, then the waiters first, quitter, second and third.
    const store = new MemoryStore();
    const holder = await store.acquire('product:42');
    const granted: string[] = [];
    const take = (name: string, signal?: AbortSignal) =>
      store.acquire('product:42', { signal }).then(async (lease) => {
        granted.push(name);
        await lease[Symbol.asyncDispose]();
      });
    const first = take('first');
    const cancel = new AbortController();
    const quitter = take('quitter', cancel.signal);
    const second = take('second');
    const third = take('third');

    // Act
    cancel.abort();
    await assert.rejects(quitter, { name: 'AbortError' });
    await holder[Symbol.asyncDispose]();
    await Promise.all([first, second, third]);

    // Assert
    assert.deepEqual(granted, ['first', 'second', 'third']);
  });
});
