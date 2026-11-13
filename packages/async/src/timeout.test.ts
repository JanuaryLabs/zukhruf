import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';

import { timeout } from './timeout.ts';

describe('timeout', () => {
  test('a timeout that the block disposed never aborts, and leaves no timer on the clock', async () => {
    // Arrange
    const clock = createClock();
    let signal: AbortSignal;
    let timersInBlock: number;

    // Act
    {
      using limit = timeout(100, { clock });
      signal = limit.signal;
      timersInBlock = clock.countTimers();
    }
    await clock.tickAsync(1_000);

    // Assert
    assert.equal(timersInBlock, 1, 'The timeout must start a timer');
    assert.equal(clock.countTimers(), 0, 'The disposal must stop the timer');
    assert.equal(signal.aborted, false);
  });

  test('the signal aborts after exactly the given milliseconds on the clock, not before', async () => {
    // Arrange
    const clock = createClock();
    using limit = timeout(100, { clock });
    const abortedAtStart = limit.signal.aborted;

    // Act
    await clock.tickAsync(99);
    const abortedEarly = limit.signal.aborted;
    await clock.tickAsync(1);

    // Assert
    assert.equal(abortedAtStart, false);
    assert.equal(
      abortedEarly,
      false,
      'The signal must not abort before 100 ms',
    );
    assert.equal(limit.signal.aborted, true, 'The signal must abort at 100 ms');
  });

  test('the signal aborts with a DOMException named TimeoutError, as the signal of AbortSignal.timeout does', async () => {
    // Arrange
    const clock = createClock();
    using limit = timeout(10, { clock });

    // Act
    await clock.tickAsync(10);

    // Assert
    const reason: unknown = limit.signal.reason;
    assert.ok(reason instanceof DOMException);
    assert.equal(reason.name, 'TimeoutError');
    assert.equal(reason.message, 'The operation was aborted due to timeout');
  });

  test('a timeout longer than one timer can hold (2^31 ms; a Node timer fires such a delay at once) aborts after exactly that time, not before', async () => {
    // Arrange: createClock() fires a timer above 2^31-1 ms after 1 ms, as Node.js does.
    const clock = createClock();
    const thirtyDays = 30 * 24 * 60 * 60_000;
    using limit = timeout(thirtyDays, { clock });

    // Act
    await clock.tickAsync(thirtyDays - 1);
    const abortedEarly = limit.signal.aborted;
    await clock.tickAsync(1);

    // Assert
    assert.equal(
      abortedEarly,
      false,
      'The signal must not abort before 30 days',
    );
    assert.equal(
      limit.signal.aborted,
      true,
      'The signal must abort at 30 days',
    );
  });

  test('a time that its parts do not divide aborts after exactly that time: the last part is the remainder', async () => {
    // Arrange: 95 ms counts in parts of 10 ms, and 5 ms are left for the last.
    const clock = createClock();
    using limit = timeout(95, { clock });

    // Act
    await clock.tickAsync(94);
    const abortedEarly = limit.signal.aborted;
    await clock.tickAsync(1);

    // Assert
    assert.equal(abortedEarly, false, 'The signal must not abort before 95 ms');
    assert.equal(limit.signal.aborted, true, 'The signal must abort at 95 ms');
  });

  test('a timer that fires late, as after the computer slept, uses up only its own part of the timeout: the signal aborts after the rest of the time, not at the wake', async () => {
    // Arrange: jump() moves the clock at once and fires each due timer one
    // time, as a process that the system stopped for that time.
    const clock = createClock();
    using limit = timeout(1_000, { clock });
    await clock.tickAsync(50);

    // Act
    clock.jump(600_000);
    await clock.tickAsync(0);
    const abortedAtWake = limit.signal.aborted;
    await clock.tickAsync(899);
    const abortedBeforeTheRest = limit.signal.aborted;
    await clock.tickAsync(1);

    // Assert
    assert.equal(
      abortedAtWake,
      false,
      'The time of the sleep must not use up the timeout',
    );
    assert.equal(
      abortedBeforeTheRest,
      false,
      'The signal must not abort before the rest of the time',
    );
    assert.equal(
      limit.signal.aborted,
      true,
      'The signal must abort when the rest of the time ends',
    );
  });
});
