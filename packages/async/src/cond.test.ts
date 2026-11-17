import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, test } from 'node:test';
import { setImmediate as afterPendingReactions } from 'node:timers/promises';

import { Cond } from './cond.ts';

describe('Cond', () => {
  test('a wait that cancels rejects with the reason of the signal, and the other wait still ends at the broadcast', async () => {
    // Arrange
    const cond = new Cond();
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const ended: unknown[] = [];
    void cond
      .wait({ signal: controller.signal })
      .catch((error: unknown) => ended.push(error));
    void cond.wait({ signal: undefined }).then(() => ended.push('other'));

    // Act
    controller.abort(reason);
    await afterPendingReactions();
    const afterCancel = [...ended];
    cond.broadcast();
    await afterPendingReactions();

    // Assert
    assert.deepEqual(
      afterCancel,
      [reason],
      'A cancel must reject only its own wait',
    );
    assert.deepEqual(ended, [reason, 'other']);
  });

  test('a signal that aborted before the call rejects the wait at once with its reason', async () => {
    // Arrange
    const cond = new Cond();
    const reason = new Error('cancelled before the call');
    const ended: unknown[] = [];

    // Act
    void cond
      .wait({ signal: AbortSignal.abort(reason) })
      .then(() => ended.push('woken'))
      .catch((error: unknown) => ended.push(error));
    await afterPendingReactions();

    // Assert
    assert.deepEqual(ended, [reason]);
  });

  test('a signal that lives long keeps no abort listener after waits that a broadcast woke', async () => {
    // Arrange
    const cond = new Cond();
    const shutdown = new AbortController();
    const ended: string[] = [];

    // Act
    for (let round = 0; round < 5; round++) {
      void cond
        .wait({ signal: shutdown.signal })
        .then(() => ended.push('woken'));
      cond.broadcast();
      await afterPendingReactions();
    }

    // Assert
    assert.deepEqual(ended, ['woken', 'woken', 'woken', 'woken', 'woken']);
    assert.equal(
      getEventListeners(shutdown.signal, 'abort').length,
      0,
      'A wait must remove its abort listener when it ends',
    );
  });

  test('a broadcast wakes every wait that started before it', async () => {
    // Arrange
    const cond = new Cond();
    const ended: string[] = [];
    void cond.wait({ signal: undefined }).then(() => ended.push('first'));
    await afterPendingReactions();
    void cond.wait({ signal: undefined }).then(() => ended.push('second'));
    await afterPendingReactions();
    const beforeBroadcast = [...ended];

    // Act
    cond.broadcast();
    await afterPendingReactions();

    // Assert
    assert.deepEqual(
      beforeBroadcast,
      [],
      'A wait must go on until a broadcast',
    );
    assert.deepEqual(ended, ['first', 'second']);
  });

  test('a wait that starts in the same step just before the broadcast is woken', async () => {
    // Arrange
    const cond = new Cond();
    const ended: string[] = [];

    // Act
    void cond.wait({ signal: undefined }).then(() => ended.push('wait'));
    cond.broadcast();
    await afterPendingReactions();

    // Assert
    assert.deepEqual(ended, ['wait']);
  });

  test('a wait that starts after a broadcast goes on until the next broadcast', async () => {
    // Arrange
    const cond = new Cond();
    cond.broadcast();
    const ended: string[] = [];

    // Act
    void cond.wait({ signal: undefined }).then(() => ended.push('wait'));
    await afterPendingReactions();
    const afterEarlierBroadcast = [...ended];
    cond.broadcast();
    await afterPendingReactions();

    // Assert
    assert.deepEqual(
      afterEarlierBroadcast,
      [],
      'A broadcast must keep nothing for a later wait',
    );
    assert.deepEqual(ended, ['wait']);
  });

  test('a loop that checks its state again after each wake ends when the state changes', async () => {
    // Arrange
    const cond = new Cond();
    const queue: string[] = [];
    const taken: string[] = [];
    const wakes: number[] = [];
    void (async () => {
      // The cap ends a loop that a broken cond wakes again and again, so the test fails and does not hang.
      while (queue.length === 0 && wakes.length < 3) {
        await cond.wait({ signal: undefined });
        wakes.push(queue.length);
      }
      taken.push(...queue.splice(0));
    })();
    await afterPendingReactions();

    // Act
    cond.broadcast();
    await afterPendingReactions();
    const afterEmptyWake = { wakes: [...wakes], taken: [...taken] };
    queue.push('job');
    cond.broadcast();
    await afterPendingReactions();

    // Assert
    assert.deepEqual(
      afterEmptyWake,
      { wakes: [0], taken: [] },
      'A wake with no change must send the loop back to wait',
    );
    assert.deepEqual({ wakes, taken }, { wakes: [0, 1], taken: ['job'] });
  });
});
