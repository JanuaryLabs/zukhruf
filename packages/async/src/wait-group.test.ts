import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, test } from 'node:test';
import { setImmediate as afterPendingReactions } from 'node:timers/promises';

import { WaitGroup } from './wait-group.ts';

describe('WaitGroup', () => {
  test('a wait that cancels rejects with the reason of the signal, and the other waits still end when the count reaches zero', async () => {
    // Arrange
    const group = new WaitGroup();
    const work = group.add();
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const ended: unknown[] = [];
    void group
      .wait({ signal: controller.signal })
      .catch((error: unknown) => ended.push(error));
    void group.wait({ signal: undefined }).then(() => ended.push('other'));

    // Act
    controller.abort(reason);
    await afterPendingReactions();
    const afterCancel = [...ended];
    work[Symbol.dispose]();
    await afterPendingReactions();

    // Assert
    assert.deepEqual(
      afterCancel,
      [reason],
      'A cancel must reject only its own wait',
    );
    assert.deepEqual(ended, [reason, 'other']);
  });

  test('a signal that aborted before the call rejects the wait with its reason, also when the count is zero', async () => {
    // Arrange
    const group = new WaitGroup();
    const reason = new Error('cancelled before the call');

    // Act
    const waiting = group.wait({ signal: AbortSignal.abort(reason) });

    // Assert
    await assert.rejects(waiting, (error) => error === reason);
  });

  test('a signal that lives long keeps no abort listener after waits that ended at zero', async () => {
    // Arrange
    const group = new WaitGroup();
    const shutdown = new AbortController();

    // Act
    for (let round = 0; round < 5; round++) {
      const work = group.add();
      const waiting = group.wait({ signal: shutdown.signal });
      work[Symbol.dispose]();
      await afterPendingReactions();
    }

    // Assert
    assert.equal(
      getEventListeners(shutdown.signal, 'abort').length,
      0,
      'A wait must remove its abort listener when it ends',
    );
  });

  test('a second dispose of one token counts once, so the wait goes on until the other token is disposed', async () => {
    // Arrange
    const group = new WaitGroup();
    const first = group.add();
    const second = group.add();
    const ended: string[] = [];
    void group.wait({ signal: undefined }).then(() => ended.push('wait'));

    // Act
    first[Symbol.dispose]();
    first[Symbol.dispose]();
    await afterPendingReactions();
    const afterDoubleDispose = [...ended];
    second[Symbol.dispose]();
    await afterPendingReactions();

    // Assert
    assert.deepEqual(
      afterDoubleDispose,
      [],
      'A second dispose of one token must not count down again',
    );
    assert.deepEqual(ended, ['wait']);
  });

  test('a wait ends at once when the count is zero', async () => {
    // Arrange
    const group = new WaitGroup();
    const ended: string[] = [];

    // Act
    void group.wait({ signal: undefined }).then(() => ended.push('wait'));
    await afterPendingReactions();

    // Assert
    assert.deepEqual(ended, ['wait']);
  });

  test('a wait ends only when the last token is disposed, also by using at the end of a block', async () => {
    // Arrange
    const group = new WaitGroup();
    const ended: string[] = [];
    const first = group.add();
    void group.wait({ signal: undefined }).then(() => ended.push('wait'));

    // Act
    const states: string[][] = [];
    {
      using _second = group.add();
      first[Symbol.dispose]();
      await afterPendingReactions();
      states.push([...ended]);
    }
    await afterPendingReactions();

    // Assert
    assert.deepEqual(
      states,
      [[]],
      'The wait must go on while a token is not disposed',
    );
    assert.deepEqual(ended, ['wait']);
  });

  test('the count can go up again after zero, and a new wait then waits for the new work', async () => {
    // Arrange
    const group = new WaitGroup();
    group.add()[Symbol.dispose]();
    const ended: string[] = [];

    // Act
    const work = group.add();
    void group.wait({ signal: undefined }).then(() => ended.push('wait'));
    await afterPendingReactions();
    const whileWorkRuns = [...ended];
    work[Symbol.dispose]();
    await afterPendingReactions();

    // Assert
    assert.deepEqual(
      whileWorkRuns,
      [],
      'A wait must go on while the new work runs',
    );
    assert.deepEqual(ended, ['wait']);
  });

  test('a wait that started before the count reached zero ends, also when an add follows the zero in the same step', async () => {
    // Arrange
    const group = new WaitGroup();
    const work = group.add();
    const ended: string[] = [];
    void group.wait({ signal: undefined }).then(() => ended.push('early'));

    // Act
    work[Symbol.dispose]();
    const next = group.add();
    void group.wait({ signal: undefined }).then(() => ended.push('late'));
    await afterPendingReactions();
    const beforeNextDispose = [...ended];
    next[Symbol.dispose]();
    await afterPendingReactions();

    // Assert
    assert.deepEqual(
      beforeNextDispose,
      ['early'],
      'Only the wait that started before the zero must end at the zero',
    );
    assert.deepEqual(ended, ['early', 'late']);
  });
});
