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

test('hill climbing under steady work stops doubling the pause between two steps at sixteen windows', () => {
  // Arrange
  const sizing = new HillClimbing({
    memoryPerWorker: 1,
    computer: { availableParallelism: () => 4, availableMemory: () => 2 ** 40 },
  });
  // The pool runs as many workers as the sizing says, and the work has two
  // units: a job takes 50 ms, a third worker adds no jobs, and one worker
  // fewer does worse, so no step changes the size. A job that started before
  // the size changed is not measurable, as in the pool.
  const tries: number[] = [];
  let now = 0;
  let steady = 0;
  let current = sizing.current;
  let kept = sizing.kept;

  // Act
  while (tries.length < 40 && now < 7_200_000) {
    now += 50 / Math.min(current, 2);
    const started = now - 50;
    sizing.record({ started, finished: now, measurable: started >= steady });
    // A step with one more worker keeps one more: the pool starts it.
    if (sizing.kept > kept) tries.push(now);
    kept = sizing.kept;
    if (sizing.current !== current) {
      current = sizing.current;
      steady = now;
    }
  }

  // Assert
  // The pause after the n-th step that changes nothing is 2^(n-1) windows of
  // two seconds, at most 16, times 0.5 to 1.5. A step with one more and a step
  // with fewer alternate, so two pauses and two steps of three windows lie
  // between two tries. From the fifth pause on, each pause is capped: 16 to 48
  // seconds. The third gap and each one after it hold two capped pauses and six
  // windows of a little more than two seconds: more than 44 seconds and less
  // than 110. A cap of 8 windows gives 28 to 62 seconds, and a cap of 32 gives
  // 76 to 206, so 37 capped gaps all in range leave neither a chance.
  const gaps = tries.slice(1).map((at, index) => at - tries[index]!);
  assert.equal(
    tries.length,
    40,
    `steps with one more worker stopped: gaps ${gaps.map(Math.round).join(', ')} ms`,
  );
  const capped = gaps.slice(2);
  assert.ok(
    capped.every((gap) => gap > 44_000 && gap < 110_000),
    `the gaps between two tries were ${gaps.map(Math.round).join(', ')} ms`,
  );
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

void test.each([0, Infinity, 2 ** 31], (after) =>
  test(`an idle timeout throws a RangeError for ${after} ms, a time that a timer cannot keep`, () => {
    assert.throws(() => new IdleTimeout({ after }), RangeError, String(after));
  }),
);

void test.each([1, 2_147_483_647], (after) =>
  test(`an idle timeout takes ${after} ms, a time that a timer can keep`, () => {
    assert.doesNotThrow(() => new IdleTimeout({ after }), String(after));
  }),
);

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
