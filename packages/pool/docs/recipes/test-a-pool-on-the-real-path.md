# Recipe: Test a pool on the real path

**Use case.** You change a sizing, or code that uses a pool, and you want a test that fails when callers would see the pool do the wrong thing. A test that gives a sizing made-up jobs shows what the sizing decides. It does not show that the pool starts, keeps and closes its workers by that decision. So the test runs a real pool with real workers. The pool reads its time from the clock that the test gives, so its windows of two seconds take no real time.

**What you need.** `node:test`, a small helper program that the test starts as a real worker, `p-queue` for an engine that the jobs share, `createClock()` of `@sinonjs/fake-timers`, and `delay` of `@zukhruf/async`.

## The steps

1. Build a real `Pool` with real workers. Give it a fake clock: `clock: createClock()`. The helper answers each request at once.
2. Make each job wait its time on the clock: `await delay(ms, { clock, signal: undefined })`. A job on the clock takes the same time in each run, so the sizing measures exact windows.
3. Make the work decide the size. The jobs share an engine of a few units, as helpers share a chip. Compute the time of a job with the jobs that do their own part while others use the engine: with `c` workers, a job takes `max(own + engine, c × engine / units)`.
4. Move the clock 10 ms at a time, and let the event loop turn between two moves, so that the real helpers start and close. Do not move the clock while a worker starts (`pool.stats.starting > 0`). A warm-up then takes no time on the clock, as the pool measures no job until its workers are ready.
5. Move the clock until a fact that callers see is true, such as a count in `pool.stats`. Then wait for the real exit of a worker that the pool closed.
6. Stop the jobs at the end of the test. Move the clock until each caller ends: the last job of each caller waits on the clock.
7. Give the sizing a plain computer: `computer: { availableParallelism: () => 4, availableMemory: () => 2 ** 40 }`. The test then gets the same capacity on each computer that runs it. To show other processes that take the memory, let `availableMemory` return a variable, and change the variable.
8. Run the tests at the same time: `describe(name, { concurrency: true }, ...)`. Each test moves only its own clock and reads only its own computer.
9. Run each claim for each sizing with `test.each` of `@zukhruf/testing/node`.

## The program

The jobs share an engine of three units. A fourth worker only waits for a unit, so `HillClimbing` settles at three workers: the step that tries the fourth closes it.

```ts title="real-path.test.ts"
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { describe, test } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';
import PQueue from 'p-queue';

import { delay } from '@zukhruf/async';
import { Coprocess } from '@zukhruf/coprocess';
import { HillClimbing, NoEviction, Parallel, Pool } from '@zukhruf/pool';

type FakeClock = ReturnType<typeof createClock>;

/**
 * Moves the clock 10 ms at a time until `done` holds, and lets the event loop
 * turn between two moves, so that the real helpers start and close on time.
 * While a helper starts, the clock waits: a warm-up takes no time on the
 * clock, as the pool measures no job until its helpers are ready.
 */
async function drive(
  clock: FakeClock,
  pool: Pool<Coprocess>,
  done: () => boolean,
  limit: number,
): Promise<void> {
  const end = clock.now + limit;
  while (!done()) {
    if (clock.now >= end) throw new Error(`Not done after ${limit} ms`);
    if (pool.stats.starting === 0) await clock.tickAsync(10);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

if (process.argv[2] === 'helper') {
  // A real helper process: it answers each request at once.
  for await (const line of createInterface({ input: process.stdin }))
    process.stdout.write(`${line}\n`);
} else {
  void describe('a pool that learns', { concurrency: true }, () => {
    void test('a HillClimbing pool settles where one more worker stops paying', async () => {
      const clock = createClock();
      // The jobs share an engine of three units: a fourth worker only waits.
      const engine = new PQueue({ concurrency: 3 });
      const started: Coprocess[] = [];
      const closed: Coprocess[] = [];
      await using pool = new Pool({
        // A computer with four CPUs and memory for many workers.
        size: new HillClimbing({
          memoryPerWorker: 1,
          computer: {
            availableParallelism: () => 4,
            availableMemory: () => 2 ** 40,
          },
        }),
        startup: new Parallel(),
        eviction: new NoEviction(),
        clock,
        create: () => {
          const helper = new Coprocess(
            process.execPath,
            [import.meta.filename, 'helper'],
            { name: 'helper' },
          );
          started.push(helper);
          void helper.exited().then(() => closed.push(helper));
          return helper;
        },
      });
      const stop = new AbortController();
      // Each job waits 50 ms of the clock for a unit of the engine.
      const callers = Array.from({ length: 16 }, async () => {
        while (!stop.signal.aborted)
          await pool.use(() =>
            engine.add(() => delay(50, { clock, signal: undefined })),
          );
      });
      try {
        // A step that does not pay drops the worker it tried: the pool
        // holds three again after it started a fourth.
        const held = () => {
          const { starting, idle, lent } = pool.stats;
          return starting + idle + lent;
        };
        await drive(
          clock,
          pool,
          () => started.length >= 4 && held() === 3,
          60_000,
        );

        // The pool closes the helper it dropped.
        await started[3]!.exited();
        assert.deepEqual([started.length, closed.length], [4, 1]);
      } finally {
        stop.abort();
        // The last job of each caller waits on the clock.
        let ended = false;
        const ending = Promise.all(callers).finally(() => {
          ended = true;
        });
        await drive(clock, pool, () => ended, 60_000);
        await ending;
      }
    });
  });
}
```

Output of `node --test real-path.test.ts`:

```
▶ a pool that learns
  ✔ a HillClimbing pool settles where one more worker stops paying (645.15325ms)
✔ a pool that learns (645.815625ms)
ℹ tests 1
ℹ suites 1
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 919.207209
```

## What the output shows

- The test ran for 0.6 seconds of real time. The windows of the pool, at least 2 seconds each, ran on the fake clock.
- The pool started a fourth helper for a step, found that it did not pay, and closed it. Three helpers stayed.

## Things to know

- **Assert what the step changes, not only what it touches.** A step with one more worker lends one more for a short time also when the worker does not pay. To show that the pool keeps a worker, move the clock 15 seconds after the worker started. Then wait for the real exit of each worker that the pool closed, and check that the worker is still alive.
- **Give the clock to the pool, not to the process.** Do not replace the global timers with `t.mock.timers`. Node's mock does not replace `performance.now`, and it changes the time of every test in the process. A pool reads only the clock that you give ([ADR 0008](../adr/0008-the-pool-measures-and-waits-on-the-clock-that-the-caller-gives.md)).
- **Let the clock give all the time of a job.** The clock moves at each turn of the event loop. A job that also waits for a real answer of its helper gets more time on the clock while it waits, so the sizing measures the load of the computer.
- **Prove each test with a mutation.** Break the source on purpose, in a copy, the way the test says it guards against, and see the test fail. A test that passes while the code is broken proves nothing.
- **Give inputs, not mocks.** The pool takes the clock and the computer as inputs, so a test replaces nothing that the whole process reads. To show other processes that take the memory, let the `availableMemory` of the computer return a variable, and change the variable.
- **The pool tests of this package are examples.** See the suite `a pool whose sizing keeps learning` in [src/pool.test.ts](../../src/pool.test.ts).
