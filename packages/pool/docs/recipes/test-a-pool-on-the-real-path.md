# Recipe: Test a pool on the real path

**Use case.** You change a sizing, or code that uses a pool, and you want a test that fails when callers would see the pool do the wrong thing. A test that gives a sizing made-up jobs shows what the sizing decides. It does not show that the owner starts, keeps and closes its workers by that decision. So the test runs a real `PoolWorkers` with real workers, and sends real jobs with a `Pool`. Both read their time from the clock that the test gives, so the sizing's windows of two seconds take no real time.

**What you need.** `node:test`, a small helper program that the test starts as a real worker, `p-queue` for an engine that the jobs share, `createClock()` of `@sinonjs/fake-timers`, `delay` of `@zukhruf/async`, and a store in a temporary folder.

## The steps

1. Build a real `PoolWorkers` with real workers, and a `Pool`, on a store of the test's own. Give both one fake clock that starts at the time of day: `createClock(Date.now())`. The store keeps the dates of its jobs on it.
2. Make the worker's `run` wait the job's time on the clock: `await delay(ms, { clock, signal: undefined })`. A job on the clock takes the same time in each run, so the sizing measures exact windows. The wakes of the store travel in real time, so a job needs no move of the clock to reach the owner or its caller.
3. Make the work decide the size. The jobs share an engine of a few units, as helpers share a chip. Compute the time of a job with the jobs that do their own part while others use the engine: with `c` workers, a job takes `max(own + engine, c × engine / units)`.
4. Move the clock 10 ms at a time, and let the event loop turn between two moves, so that the real helpers start and close, and the store settles each job. Do not move the clock while a worker starts (`workers.stats.starting > 0`). A warm-up then takes no time on the clock, as the owner measures no job until its workers are ready.
5. Move the clock until a fact that callers see is true, such as a count in `workers.stats`. Then wait for the real exit of a worker that the owner closed.
6. Stop the jobs at the end of the test. Move the clock until each caller ends: the last job of each caller waits on the clock.
7. Give the sizing a plain computer: `computer: { availableParallelism: () => 4, availableMemory: () => 2 ** 40 }`. The test then gets the same capacity on each computer that runs it. To show other processes that take the memory, let `availableMemory` return a variable, and change the variable.
8. Run the tests at the same time: `describe(name, { concurrency: true }, ...)`. Each test moves only its own clock and reads only its own computer.
9. Run each claim for each sizing with `test.each` of `@zukhruf/parameterized-test`.

## The program

The jobs share an engine of three units. A fourth worker only waits for a unit, so `HillClimbing` settles at three workers: the step that tries the fourth closes it.

```ts title="real-path.test.ts"
import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { createClock } from '@sinonjs/fake-timers';
import PQueue from 'p-queue';

import { delay } from '@zukhruf/async';
import {
  HillClimbing,
  NoEviction,
  Parallel,
  Pool,
  PoolWorkers,
  type Worker,
  WorkerKind,
} from '@zukhruf/pool';
import { Command, Coprocess } from '@zukhruf/process';

type FakeClock = ReturnType<typeof createClock>;

const job = new WorkerKind<null, null>({
  name: 'job',
  revision: 1,
  policy: 'standard',
  retryLimit: 0,
  expireInSeconds: 60,
});

/** The helper runs on real time: only the jobs wait on the test's clock. */
async function startHelper(): Promise<Coprocess> {
  const helper = new Command(
    process.execPath,
    [import.meta.filename, 'helper'],
    { name: 'helper', env: process.env, clock: globalThis },
  );
  return new Coprocess(await helper.start());
}

/** A worker of a real helper process, whose run waits its time on the test's clock. */
class HelperWorker implements Worker<null, null> {
  readonly #helper = startHelper();
  readonly #work: () => Promise<void>;

  constructor(work: () => Promise<void>) {
    this.#work = work;
  }

  ready(): Promise<unknown> {
    return this.#helper;
  }

  async run(): Promise<null> {
    await this.#work();
    return null;
  }

  async exited(): Promise<unknown> {
    return (await this.#helper).exited();
  }

  kill(): void {
    // A helper that did not start has nothing to kill: ready() rejected
    // with its StartError.
    void this.#helper.then(
      (helper) => helper.process.signal('SIGKILL'),
      () => false,
    );
  }

  async close(): Promise<void> {
    await (await this.#helper).close();
  }
}

/**
 * Moves the clock 10 ms at a time until `done` holds, and lets the event loop
 * turn between two moves, so that the real helpers start and close on time,
 * and the store settles each job between two moves. While a helper starts,
 * the clock waits: a warm-up takes no time on the clock, as the owner
 * measures no job until its helpers are ready.
 */
async function drive(
  clock: FakeClock,
  workers: PoolWorkers<null, null>,
  done: () => boolean,
  limit: number,
): Promise<void> {
  const end = clock.now + limit;
  while (!done()) {
    if (clock.now >= end) throw new Error(`Not done after ${limit} ms`);
    if (workers.stats.starting === 0) await clock.tickAsync(10);
    await setImmediate();
  }
}

if (process.argv[2] === 'helper') {
  // A real helper process: it answers each request at once.
  for await (const line of createInterface({ input: process.stdin }))
    process.stdout.write(`${line}\n`);
} else {
  void describe('an owner that learns', { concurrency: true }, () => {
    void test('a HillClimbing owner settles where one more worker stops paying', async () => {
      // The clock starts at the time of day: the store keeps real dates.
      const clock = createClock(Date.now());
      await using folder = await mkdtempDisposable(join(tmpdir(), 'pool-'));
      const store = join(folder.path, 'store.sqlite');
      // The jobs share an engine of three units: a fourth worker only waits.
      const engine = new PQueue({ concurrency: 3 });
      const started: HelperWorker[] = [];
      const closed: HelperWorker[] = [];
      await using workers = new PoolWorkers({
        kind: job,
        store,
        clock,
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
        create: () => {
          // Each job waits 50 ms of the clock for a unit of the engine.
          const helper = new HelperWorker(async () => {
            await engine.add(() => delay(50, { clock, signal: undefined }));
          });
          started.push(helper);
          void helper.exited().then(() => closed.push(helper));
          return helper;
        },
      });
      await using pool = new Pool({ kind: job, store, clock });
      const stop = new AbortController();
      const callers = Array.from({ length: 16 }, async () => {
        while (!stop.signal.aborted) await pool.run(null);
      });
      try {
        // A step that does not pay drops the worker it tried: the owner
        // holds three again after it started a fourth.
        const held = () => {
          const { starting, idle, lent } = workers.stats;
          return starting + idle + lent;
        };
        await drive(
          clock,
          workers,
          () => started.length >= 4 && held() === 3,
          60_000,
        );

        // The owner closes the helper it dropped.
        await started[3]!.exited();
        assert.deepEqual([started.length, closed.length], [4, 1]);
      } finally {
        stop.abort();
        // The last job of each caller waits on the clock.
        let ended = false;
        const ending = Promise.all(callers).finally(() => {
          ended = true;
        });
        await drive(clock, workers, () => ended, 60_000);
        await ending;
      }
    });
  });
}
```

Output of `node --test real-path.test.ts`:

```
▶ an owner that learns
  ✔ a HillClimbing owner settles where one more worker stops paying (16731.160417ms)
✔ an owner that learns (16731.784167ms)
ℹ tests 1
ℹ suites 1
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 17040.414709
```

## What the output shows

- The windows of the sizing, at least 2 seconds each, ran on the fake clock. The test ran for 17 seconds of real time: each job is two synced writes of the store and two wakes, and a step of the sizing needs some hundreds of jobs.
- The owner started a fourth helper for a step, found that it did not pay, and closed it. Three helpers stayed.

## Things to know

- **Assert what the step changes, not only what it touches.** A step with one more worker lends one more for a short time also when the worker does not pay. To show that the owner keeps a worker, move the clock 15 seconds after the worker started. Then wait for the real exit of each worker that the owner closed, and check that the worker is still alive.
- **Give the clock to the pool, not to the process.** Do not replace the global timers with `t.mock.timers`. Node's mock does not replace `performance.now`, and it changes the time of every test in the process. A `Pool` and a `PoolWorkers` read only the clock that you give ([ADR 0008](../adr/0008-the-pool-measures-and-waits-on-the-clock-that-the-caller-gives.md)).
- **Let the clock give all the time of a job.** The clock moves at each turn of the event loop. A job that also waits for a real answer of its helper gets more time on the clock while it waits, so the sizing measures the load of the computer.
- **Prove each test with a mutation.** Break the source on purpose, in the memory of the test process, the way the test says it guards against, and see the test fail. A test that passes while the code is broken proves nothing.
- **Give inputs, not mocks.** The pool takes the clock, the computer and the store as inputs, so a test replaces nothing that the whole process reads. To show other processes that take the memory, let the `availableMemory` of the computer return a variable, and change the variable.
- **The pool tests of this package are examples.** See the suite `an owner whose sizing keeps learning` in [src/pool-workers.test.ts](../../src/pool-workers.test.ts).
