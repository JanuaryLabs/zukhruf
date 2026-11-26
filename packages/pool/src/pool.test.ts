import assert from 'node:assert/strict';

import { createClock } from '@sinonjs/fake-timers';

import { test } from '@zukhruf/parameterized-test';

import { Gradient, HillClimbing, IdleTimeout, type Sizing } from './index.ts';

// One window at the current size: jobs finishing at the given rate a second,
// each taking the given milliseconds, until at least twenty jobs and two
// seconds passed. Returns the clock after it.
function window(
  sizing: Sizing,
  start: number,
  perSecond: number,
  milliseconds: number,
) {
  const jobs = Math.max(20, Math.ceil(2 * perSecond));
  for (let job = 0; job <= jobs; job++) {
    const finished = start + (job * 1000) / perSecond;
    sizing.record({
      started: finished - milliseconds,
      finished,
      measurable: true,
    });
  }
  return start + (jobs * 1000) / perSecond + 1;
}

test('hill climbing tries one more worker between two windows at its size and keeps it while it adds a tenth more throughput', () => {
  const sizing = new HillClimbing({
    memoryPerWorker: 1,
    computer: { availableParallelism: () => 4, availableMemory: () => 2 ** 40 },
  });
  assert.equal(sizing.ceiling, 4, 'the four CPUs of the computer');
  assert.deepEqual([sizing.current, sizing.kept], [2, 2]);

  let clock = window(sizing, 0, 10, 1);
  assert.deepEqual([sizing.current, sizing.kept], [3, 3], 'it tries three');
  clock = window(sizing, clock, 14, 1);
  assert.deepEqual(
    [sizing.current, sizing.kept],
    [2, 3],
    'it measures two again, keeping the third worker alive',
  );
  clock = window(sizing, clock, 10, 1);
  assert.deepEqual([sizing.current, sizing.kept], [3, 3], 'three paid');

  clock = window(sizing, clock, 14, 1);
  clock = window(sizing, clock, 14.7, 1);
  clock = window(sizing, clock, 14, 1);
  // Four added only 5%: it keeps three, and after a pause its next step tries
  // two while it keeps the third worker alive.
  assert.deepEqual([sizing.current, sizing.kept], [3, 3]);
  for (let windows = 0; sizing.current === 3 && windows < 4; windows++)
    clock = window(sizing, clock, 14, 1);
  assert.deepEqual([sizing.current, sizing.kept], [2, 3]);
});

test('hill climbing is not fooled by work that gets slower while it measures', () => {
  const sizing = new HillClimbing({
    memoryPerWorker: 1,
    computer: { availableParallelism: () => 3, availableMemory: () => 2 ** 40 },
  });
  assert.equal(sizing.ceiling, 3, 'the three CPUs of the computer');
  // Two workers manage 24 fast files a second at first and 8 slow ones later;
  // three, measured between, manage half again what two do at that point.
  let clock = window(sizing, 0, 24, 1);
  clock = window(sizing, clock, 24, 1);
  window(sizing, clock, 8, 1);
  assert.equal(sizing.current, 3);
});

test('a climbing sizing learns nothing from jobs that were not measurable or from windows under two seconds, and never passes its ceiling', () => {
  const idle = new HillClimbing({
    memoryPerWorker: 1,
    computer: { availableParallelism: () => 4, availableMemory: () => 2 ** 40 },
  });
  const fast = new Gradient({
    memoryPerWorker: 1,
    computer: { availableParallelism: () => 4, availableMemory: () => 2 ** 40 },
  });
  for (let job = 0; job < 1000; job++) {
    idle.record({ started: job, finished: job + 1, measurable: false });
    fast.record({ started: job, finished: job + 1, measurable: true });
  }
  assert.deepEqual([idle.current, fast.current], [2, 2]);

  // Four CPUs, but the free memory of half a worker: at least one.
  const small = new HillClimbing({
    memoryPerWorker: 2 ** 30,
    computer: { availableParallelism: () => 4, availableMemory: () => 2 ** 29 },
  });
  assert.equal(small.ceiling, 1);
  window(small, 0, 10, 1);
  assert.deepEqual([small.current, small.kept], [1, 1]);
});

test('gradient keeps one more worker while a job takes at most half again the time it took with two', () => {
  const sizing = new Gradient({
    memoryPerWorker: 1,
    computer: { availableParallelism: () => 4, availableMemory: () => 2 ** 40 },
  });
  assert.equal(sizing.ceiling, 4, 'the four CPUs of the computer');

  let clock = window(sizing, 0, 10, 10);
  clock = window(sizing, clock, 10, 14);
  clock = window(sizing, clock, 10, 10);
  assert.equal(sizing.current, 3, 'a job took 1.4 times as long: three pay');

  clock = window(sizing, clock, 10, 14);
  clock = window(sizing, clock, 10, 15.4);
  window(sizing, clock, 10, 14);
  // Four would make a job take 1.54 times as long as with two.
  assert.deepEqual([sizing.current, sizing.kept], [3, 3]);
});

test('an idle timeout throws a RangeError for a time that a timer cannot keep', () => {
  for (const after of [0, Infinity, 2 ** 31])
    assert.throws(() => new IdleTimeout({ after }), RangeError, String(after));
  for (const after of [1, 2_147_483_647])
    assert.doesNotThrow(() => new IdleTimeout({ after }), String(after));
});

test('an idle timeout evicts no worker and keeps no timer when its signal aborted before the call', async () => {
  // Arrange
  const clock = createClock();
  let evicted = 0;

  // Act
  new IdleTimeout({ after: 1_000 }).idle(
    AbortSignal.abort(),
    () => {
      evicted++;
    },
    clock,
  );
  await clock.tickAsync(1_000);

  // Assert
  assert.equal(evicted, 0);
  assert.equal(clock.countTimers(), 0);
});
