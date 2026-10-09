import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, test } from 'node:test';

import { untilAborted } from './until-aborted.ts';

describe('untilAborted', () => {
  test(
    'a wait ends with the reason of the signal, also when an earlier listener stops the abort event',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const controller = new AbortController();
      controller.signal.addEventListener('abort', (event) =>
        event.stopImmediatePropagation(),
      );
      const reason = new Error('cancelled');
      const waiting = untilAborted(
        new Promise<never>(() => {}),
        controller.signal,
      );
      const rejected = assert.rejects(waiting, (error) => error === reason);

      // Act
      controller.abort(reason);

      // Assert
      await rejected;
    },
  );

  test(
    'a signal that lives long keeps no abort listener after waits that fulfilled or rejected',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const shutdown = new AbortController();

      // Act
      for (let wait = 0; wait < 5; wait++) {
        await untilAborted(Promise.resolve(wait), shutdown.signal);
        await assert.rejects(
          untilAborted(
            Promise.reject(new Error('work failed')),
            shutdown.signal,
          ),
        );
      }

      // Assert
      assert.equal(
        getEventListeners(shutdown.signal, 'abort').length,
        0,
        'A wait must remove its abort listener when the work settles',
      );
    },
  );

  test(
    'a wait rejects with the reason of the signal when the signal aborts before the work ends',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const controller = new AbortController();
      const reason = new Error('cancelled');
      const waiting = untilAborted(
        new Promise<never>(() => {}),
        controller.signal,
      );
      const rejected = assert.rejects(waiting, (error) => error === reason);

      // Act
      controller.abort(reason);

      // Assert
      await rejected;
    },
  );

  test(
    'a time limit ends the wait with the TimeoutError of its signal',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const signal = AbortSignal.timeout(10);

      // Act
      const waiting = untilAborted(new Promise<never>(() => {}), signal);

      // Assert
      await assert.rejects(
        waiting,
        (error) =>
          error === signal.reason &&
          error instanceof DOMException &&
          error.name === 'TimeoutError',
      );
    },
  );

  test(
    'a signal that aborted before the call rejects the wait, also when the work already ended',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const reason = new Error('cancelled before the call');
      const signal = AbortSignal.abort(reason);

      // Act
      const pendingWork = untilAborted(new Promise<never>(() => {}), signal);
      const endedWork = untilAborted(Promise.resolve('report'), signal);

      // Assert
      await Promise.all([
        assert.rejects(pendingWork, (error) => error === reason),
        assert.rejects(endedWork, (error) => error === reason),
      ]);
    },
  );

  test(
    'a wait rejects with the error of the work when the work fails first',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const failure = new Error('work failed');

      // Act
      const waiting = untilAborted(
        Promise.reject(failure),
        new AbortController().signal,
      );

      // Assert
      await assert.rejects(waiting, (error) => error === failure);
    },
  );

  test(
    'a wait fulfills with the value of the work when the work ends first',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const work = Promise.resolve('report');

      // Act
      const value = await untilAborted(work, new AbortController().signal);

      // Assert
      assert.equal(value, 'report');
    },
  );

  test('without a signal, the wait is the promise of the work itself', () => {
    // Arrange
    const work = Promise.resolve('report');

    // Act
    const waiting = untilAborted(work, undefined);

    // Assert
    assert.equal(
      waiting,
      work,
      'Without a signal nothing can end the wait early, so no promise must wrap the work',
    );
  });
});
