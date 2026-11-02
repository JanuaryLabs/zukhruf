import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, test } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';

import { delay } from './delay.ts';

describe('delay', () => {
  test(
    'a signal that aborted before the call rejects with its reason, and leaves no timer',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const clock = createClock();
      const reason = new Error('the caller left');

      // Act
      const waiting = delay(1_000, {
        clock,
        signal: AbortSignal.abort(reason),
      });

      // Assert
      await assert.rejects(waiting, (error) => error === reason);
      assert.equal(clock.countTimers(), 0);
    },
  );

  test(
    'an abort during the wait rejects with the reason of the signal, and stops the timer',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const clock = createClock();
      const controller = new AbortController();
      const reason = new Error('the caller left');
      const waiting = delay(60_000, { clock, signal: controller.signal });
      const rejected = assert.rejects(waiting, (error) => error === reason);

      // Act
      await clock.tickAsync(1_000);
      controller.abort(reason);

      // Assert
      await rejected;
      assert.equal(clock.countTimers(), 0, 'The abort must stop the timer');
    },
  );

  test(
    'the wait ends after exactly the given milliseconds on the clock, not before',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const clock = createClock();
      let ended = false;
      void delay(100, { clock, signal: undefined }).then(() => {
        ended = true;
      });

      // Act
      await clock.tickAsync(99);
      const endedEarly = ended;
      await clock.tickAsync(1);

      // Assert
      assert.equal(endedEarly, false, 'The wait must not end before 100 ms');
      assert.equal(ended, true, 'The wait must end at 100 ms');
    },
  );

  test(
    'no listener stays on the signal after the wait ends or is cancelled',
    { timeout: 2_000 },
    async () => {
      // Arrange
      const clock = createClock();
      const kept = new AbortController();
      const cancelled = new AbortController();

      // Act
      const ending = delay(10, { clock, signal: kept.signal });
      await clock.tickAsync(10);
      await ending;
      const stopping = delay(10, { clock, signal: cancelled.signal });
      cancelled.abort();
      await stopping.catch(() => {});

      // Assert
      assert.equal(
        getEventListeners(kept.signal, 'abort').length,
        0,
        'A long-lived signal must not collect a listener for each wait',
      );
      assert.equal(getEventListeners(cancelled.signal, 'abort').length, 0);
    },
  );

  test(
    'ref false on a clock whose timers are numbers, like a browser, waits and does not throw',
    { timeout: 2_000 },
    async () => {
      // Arrange: the real timers of Node.js, given back as their numeric ids.
      const numbered = {
        setTimeout: (callback: () => void, ms: number) =>
          Number(globalThis.setTimeout(callback, ms)),
        clearTimeout: (timer: unknown) => {
          if (typeof timer === 'number') globalThis.clearTimeout(timer);
        },
        performance: globalThis.performance,
      };

      // Act
      const waiting = delay(1, {
        clock: numbered,
        signal: undefined,
        ref: false,
      });

      // Assert
      await assert.doesNotReject(waiting);
    },
  );
});
