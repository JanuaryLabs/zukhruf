# Recipe: Test a pool on the real path

**Use case.** You change a sizing, or code that uses a pool, and you want a test that fails when callers would see the pool do the wrong thing. A test that gives a sizing made-up jobs shows what the sizing decides, not that the pool starts, keeps and closes its workers by that decision. A fake clock that the whole process reads hides the timing of real processes.

**What you need.** `node:test`, a small helper program that the test starts as a real worker, and `p-queue` for an engine that the jobs share.

## The steps

1. Build a real `Pool` with real worker processes. The helper only waits the time that each job names.
2. Make the work decide the size. The jobs share an engine of a few units, as helpers share a chip. Compute the time of a job with the jobs that do their own part while others use the engine: with `c` workers, a job takes `max(own + engine, c × engine / units)`.
3. Wait for facts that callers see, with `t.waitFor`: a worker that closed, a count in `pool.stats`. Do not write a loop that sleeps between checks.
4. Fit the CI runner. A GitHub `ubuntu-latest` runner of a public repository has 4 CPUs. Let each pool settle at 3 workers or fewer, and assert `availableParallelism() >= 4`.
5. Run the tests that only wait at the same time: `describe(name, { concurrency: true }, ...)`. Run alone a test that replaces what the whole process reads, such as `process.availableMemory`, and a test that measures timing.
6. Run each claim for each sizing with `test.each` of `@zukhruf/testing/node`.

## The program

The jobs share an engine of three units. A fourth worker only waits for a unit, so `HillClimbing` settles at three workers: the step that tries the fourth closes it.

```ts title="real-path.test.ts"
import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { createInterface } from 'node:readline';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import PQueue from 'p-queue';

import { Coprocess } from '@zukhruf/coprocess';
import { HillClimbing, NoEviction, Parallel, Pool } from '@zukhruf/pool';

if (process.argv[2] === 'helper') {
  // A real helper process: it waits the milliseconds that each request names.
  for await (const line of createInterface({ input: process.stdin })) {
    await delay(JSON.parse(line));
    process.stdout.write(`${line}\n`);
  }
} else {
  // Tests that only wait for windows of two seconds run at the same time.
  void describe('a pool that learns', { concurrency: true }, () => {
    void test('a HillClimbing pool settles where one more worker stops paying', async (t) => {
      // The jobs share an engine of three units: a fourth worker only waits.
      // Three workers fit the four CPUs of a CI runner.
      const engine = new PQueue({ concurrency: 3 });
      const started: Coprocess[] = [];
      const closed: Coprocess[] = [];
      await using pool = new Pool({
        size: new HillClimbing({ memoryPerWorker: 1 }),
        startup: new Parallel(),
        eviction: new NoEviction(),
        clock: globalThis,
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
      assert.ok(availableParallelism() >= 4, 'this test needs four CPUs');
      const stop = new AbortController();
      const callers = Array.from({ length: 16 }, async () => {
        while (!stop.signal.aborted)
          await pool.use((helper) => engine.add(() => helper.request(50)));
      });
      try {
        // A step that does not pay closes the worker it tried.
        await t.waitFor(() => assert.ok(closed.length > 0), {
          interval: 50,
          timeout: 60_000,
        });

        assert.equal(started.length - closed.length, 3);
      } finally {
        stop.abort();
        await Promise.all(callers);
      }
    });
  });
}
```

Output of `node --test real-path.test.ts`:

```
▶ a pool that learns
  ✔ a HillClimbing pool settles where one more worker stops paying (13035.809333ms)
✔ a pool that learns (13037.002291ms)
ℹ tests 1
ℹ suites 1
ℹ pass 1
ℹ fail 0
```

## What the output shows

- The test ran for 13 seconds: the windows of the pool are real, at least 2 seconds each.
- The pool started a fourth helper for a step, found that it did not pay, and closed it. Three helpers stayed.

## Things to know

- **Assert what the step changes, not only what it touches.** A step with one more worker lends one more for a short time also when the worker does not pay. To show that the pool keeps a worker, check that the worker is still alive 15 seconds after it started.
- **Prove each test with a mutation.** Break the source on purpose, in a copy, the way the test says it guards against, and see the test fail. A test that passes while the code is broken proves nothing.
- **Mock only what no operation can drive**, such as the free memory of the computer, and set the mock before you build the pool.
- **The pool tests of this package are examples.** See the suite `a pool whose sizing keeps learning` in [src/pool.test.ts](../../src/pool.test.ts).
- **When the pool takes the clock as an input**, these tests drive a fake clock (`createClock()` of `@sinonjs/fake-timers`) instead of real windows, and they finish in milliseconds.
