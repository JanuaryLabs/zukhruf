import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { createClock } from '@sinonjs/fake-timers';
import PQueue from 'p-queue';

import { Latch, delay } from '@zukhruf/async';
import { describe, test } from '@zukhruf/testing/node';

import {
  Fixed,
  Gradient,
  HillClimbing,
  IdleTimeout,
  LeaderFirst,
  NoEviction,
  OnDemand,
  OrderedReady,
  Parallel,
  Pool,
  Resources,
  type Sample,
  type Sizing,
  type Worker,
} from './index.ts';

// A real child process: it warms up when the test releases it, then echoes
// each line back. A line "hang" never gets an answer.
const script = `
const lines = require('node:readline').createInterface({ input: process.stdin });
let ready = false;
lines.on('line', (line) => {
  if (!ready) {
    if (line === 'go') { ready = true; process.stdout.write('ready\\n'); }
    if (line === 'fail') process.exit(3);
    return;
  }
  if (line.startsWith('sleep ')) setTimeout(() => process.stdout.write(line + '\\n'), Number(line.slice(6)));
  else if (line !== 'hang') process.stdout.write(line + '\\n');
});
`;

class EchoWorker implements Worker {
  readonly #child = spawn(process.execPath, ['-e', script]);
  readonly #waiting: ((line: string) => void)[] = [];
  readonly #exit = new Latch();
  readonly #warm = new Latch<PromiseSettledResult<void>>();

  constructor() {
    createInterface({ input: this.#child.stdout }).on('line', (line) =>
      this.#waiting.shift()?.(line),
    );
    this.#child.once('close', () => this.#exit.open());
    this.#next().then(
      () => this.#warm.open({ status: 'fulfilled', value: undefined }),
      (reason: unknown) => this.#warm.open({ status: 'rejected', reason }),
    );
  }

  get pid(): number {
    return this.#child.pid!;
  }

  get dead(): boolean {
    const child = this.#child;
    return child.killed || child.exitCode !== null || child.signalCode !== null;
  }

  async ready(): Promise<void> {
    const warm = await this.#warm.wait();
    if (warm.status === 'rejected') throw warm.reason;
  }

  exited(): Promise<void> {
    return this.#exit.wait();
  }

  release(): void {
    this.#child.stdin.write('go\n');
  }

  fail(): void {
    this.#child.stdin.write('fail\n');
  }

  echo(text: string): Promise<string> {
    this.#child.stdin.write(`${text}\n`);
    return this.#next();
  }

  #next(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.#waiting.push(resolve);
      void this.#exit
        .wait()
        .then(() => reject(new Error('Echo worker exited')));
    });
  }

  kill(): void {
    this.#child.kill();
  }

  async close(): Promise<void> {
    this.#child.stdin.end();
    await this.#exit.wait();
  }
}

test('an on-demand pool starts no worker until a job needs one, then reuses it', async () => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(2),
    startup: new OnDemand(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock: globalThis,
  });
  await pool.ready();
  assert.equal(created.length, 0);

  assert.equal(await pool.use((worker) => worker.echo('one')), 'one');
  assert.equal(await pool.use((worker) => worker.echo('two')), 'two');
  assert.equal(created.length, 1);

  assert.deepEqual(
    await Promise.all([
      pool.use((worker) => worker.echo('a')),
      pool.use((worker) => worker.echo('b')),
      pool.use((worker) => worker.echo('c')),
    ]),
    ['a', 'b', 'c'],
  );
  assert.equal(created.length, 2);
});

test('a parallel pool starts every worker at once', async (t) => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(3),
    startup: new Parallel(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      created.push(worker);
      return worker;
    },
    clock: globalThis,
  });
  // Nothing is ready yet, so only a parallel start reaches three workers.
  await t.waitFor(() => assert.equal(created.length, 3), {
    interval: 10,
    timeout: 5000,
  });
  for (const worker of created) worker.release();
  await pool.ready();
});

test('an ordered-ready pool starts each worker after the previous one is ready', async (t) => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(3),
    startup: new OrderedReady(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      created.push(worker);
      return worker;
    },
    clock: globalThis,
  });
  await t.waitFor(() => assert.equal(created.length, 1), {
    interval: 10,
    timeout: 5000,
  });
  await setTimeout(200);
  assert.equal(created.length, 1);

  created[0]!.release();
  await t.waitFor(() => assert.equal(created.length, 2), {
    interval: 10,
    timeout: 5000,
  });
  await setTimeout(200);
  assert.equal(created.length, 2);

  created[1]!.release();
  await t.waitFor(() => assert.equal(created.length, 3), {
    interval: 10,
    timeout: 5000,
  });
  created[2]!.release();
  await pool.ready();
});

test('a leader-first pool starts the others together once the first is ready, and replaces a crashed worker at once', async () => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(3),
    startup: new LeaderFirst(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      created.push(worker);
      // Only the leader waits for the test; it models a cold cache.
      if (created.length > 1) worker.release();
      return worker;
    },
    clock: globalThis,
  });
  const job = pool.use((worker) => worker.echo('during warm-up'));
  await setTimeout(200);
  assert.equal(created.length, 1, 'no worker may start beside the leader');

  created[0]!.release();
  await pool.ready();
  assert.equal(created.length, 3);
  assert.equal(await job, 'during warm-up');

  process.kill(created[1]!.pid, 'SIGKILL');
  await created[1]!.exited();
  const results = await Promise.all(
    Array.from({ length: 3 }, (_, index) =>
      pool.use((worker) => worker.echo(String(index))),
    ),
  );
  assert.deepEqual(results, ['0', '1', '2']);
  assert.equal(created.length, 4);
});

test('a job aborted while it runs kills only its worker, and the next job takes the idle worker', async () => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(2),
    startup: new Parallel(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock: globalThis,
  });
  await pool.ready();
  const stop = new AbortController();
  const reason = new Error('Stop this job');
  const hung = pool.use((worker) => worker.echo('hang'), stop.signal);
  const other = pool.use((worker) => worker.echo('other'));
  await setTimeout(100);

  stop.abort(reason);
  await assert.rejects(hung, (error) => error === reason);
  assert.equal(await other, 'other');
  assert.equal(created[0]!.dead, true);
  assert.equal(created[1]!.dead, false);

  assert.equal(await pool.use((worker) => worker.echo('next')), 'next');
  assert.equal(created.length, 2);
  await created[0]!.exited();
});

test('a queued job aborted before its turn never runs', async () => {
  await using pool = new Pool({
    size: new Fixed(1),
    startup: new Parallel(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      return worker;
    },
    clock: globalThis,
  });
  await pool.ready();
  const first = Promise.withResolvers<void>();
  const busy = pool.use(async (worker) => {
    await first.promise;
    return worker.echo('busy');
  });
  let ran = false;
  const stop = new AbortController();
  const queued = pool.use(async (worker) => {
    ran = true;
    return worker.echo('queued');
  }, stop.signal);

  stop.abort();
  first.resolve();
  assert.equal(await busy, 'busy');
  await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(ran, false);
});

test('a job aborted while its worker warms up leaves the warm-up running for later jobs', async () => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(1),
    startup: new LeaderFirst(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      created.push(worker);
      return worker;
    },
    clock: globalThis,
  });
  const stop = new AbortController();
  const waiting = pool.use((worker) => worker.echo('never'), stop.signal);

  stop.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(created[0]!.dead, false);

  created[0]!.release();
  await pool.ready();
  assert.equal(await pool.use((worker) => worker.echo('later')), 'later');
  assert.equal(created.length, 1);
});

test('a worker that fails to start fails the job waiting for it, and the next job starts another', async () => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(1),
    startup: new OnDemand(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      if (created.length === 0) worker.fail();
      else worker.release();
      created.push(worker);
      return worker;
    },
    clock: globalThis,
  });

  await assert.rejects(
    pool.use((worker) => worker.echo('first')),
    /Echo worker exited/,
  );
  assert.equal(await pool.use((worker) => worker.echo('second')), 'second');
  assert.equal(created.length, 2);
});

test('disposing a pool stops every worker, rejects waiting and later jobs, and starts no replacement', async (t) => {
  const created: EchoWorker[] = [];
  const pool = new Pool({
    size: new Fixed(2),
    startup: new OrderedReady(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      created.push(worker);
      return worker;
    },
    clock: globalThis,
  });
  await t.waitFor(() => assert.equal(created.length, 1), {
    interval: 10,
    timeout: 5000,
  });
  const ready = assert.rejects(pool.ready());
  const jobs = Promise.allSettled(
    Array.from({ length: 3 }, () => pool.use((worker) => worker.echo('x'))),
  );

  await pool[Symbol.asyncDispose]();
  await ready;
  assert.deepEqual(
    (await jobs).map(({ status }) => status),
    ['rejected', 'rejected', 'rejected'],
  );
  await assert.rejects(
    pool.use((worker) => worker.echo('after')),
    { name: 'AbortError' },
  );
  assert.equal(created.length, 1, 'the second worker must never start');
  assert.ok(created.every((worker) => worker.dead));
});

test('a resources sizing runs one worker per CPU while each finds its memory free, and at least one', async () => {
  for (const [cpus, gibFree, expected] of [
    [3, 64, 3],
    [8, 2.5, 2],
    [4, 0.5, 1],
  ] as const) {
    const created: EchoWorker[] = [];
    await using pool = new Pool({
      size: new Resources({
        memoryPerWorker: 2 ** 30,
        computer: {
          availableParallelism: () => cpus,
          availableMemory: () => gibFree * 2 ** 30,
        },
      }),
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new EchoWorker();
        worker.release();
        created.push(worker);
        return worker;
      },
      clock: globalThis,
    });
    await pool.ready();
    assert.equal(created.length, expected);
  }
});

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

test('a hill-climbing pool grows past its first two workers while a backlog of slow jobs waits', async (t) => {
  const clock = createClock();
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    // Room for four workers: four CPUs, and memory for many more.
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
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock,
  });
  await pool.ready();
  assert.equal(created.length, 2);

  // Each job takes 20 ms on the clock, so every worker added adds as much.
  await settle(
    clock,
    [pool],
    Promise.all(
      Array.from({ length: 1500 }, () =>
        pool.use(() => delay(20, { clock, signal: undefined })),
      ),
    ),
    60_000,
  );
  assert.ok(created.length > 2, `the pool started ${created.length} workers`);
  // The step that tried a third worker kept it: a worker that a step tries
  // and closes would also count above.
  await untilExited(t, pool, created);
  assert.equal(
    created[2]!.dead,
    false,
    'the pool closed the third worker, which paid',
  );
});

// These tests run real pools of real worker processes on a fake clock: each
// job waits on the clock, so a window of two seconds takes no real time, and
// the time of each job is exact. Each sizing reads a plain computer, not the
// process, so the tests run at the same time. The test after them runs six
// pools at once, so it runs alone.
//
// In each test the jobs share an engine of a few units, as Vision workers
// share the Neural Engine: a job past the units waits for one, while the other
// jobs do their own part. Each sizing settles at three workers, so the tests
// fit a computer with four CPUs: HillClimbing on three units, where a fourth
// worker adds no jobs a second; Gradient on two units and 10 ms of the job's
// own, where a job takes 60 ms with two workers, 75 ms (1.25 times) with
// three, and 100 ms (1.67 times) with four.
void describe(
  'a pool whose sizing keeps learning',
  { concurrency: true },
  () => {
    void test.each(
      [
        { Learning: HillClimbing, units: 3, own: 0 },
        { Learning: Gradient, units: 2, own: 10 },
      ],
      ({ Learning, units, own }) =>
        test(`a ${Learning.name} pool that settled grows again when the work changes so that one more worker pays`, async (t) => {
          const clock = createClock();
          const engine = new PQueue({ concurrency: units });
          const created: EchoWorker[] = [];
          await using pool = new Pool({
            // Four CPUs, and memory for many more workers.
            size: new Learning({
              memoryPerWorker: 1,
              computer: {
                availableParallelism: () => 4,
                availableMemory: () => 2 ** 40,
              },
            }),
            startup: new Parallel(),
            eviction: new NoEviction(),
            create: () => {
              const worker = new EchoWorker();
              worker.release();
              created.push(worker);
              return worker;
            },
            clock,
          });
          const stop = new AbortController();
          const load = Array.from({ length: 16 }, async () => {
            while (!stop.signal.aborted)
              await pool.use(async () => {
                await delay(own, { clock, signal: undefined });
                await engine.add(() => delay(50, { clock, signal: undefined }));
              });
          });
          try {
            // The pool closes the worker of a step that did not pay: it settled.
            await untilDropped(t, clock, pool, created, 60_000);
            const known = created.length;

            // Four units: a fourth worker pays for both sizings.
            engine.concurrency = 4;

            // A step with one more worker starts it. The pool keeps the
            // worker when it pays, and closes it after the step when it does
            // not.
            await drive(clock, [pool], () => created.length > known, 60_000);
            const added = created[known]!;
            await runFor(clock, [pool], 15_000);
            await untilExited(t, pool, created);
            assert.equal(
              added.dead,
              false,
              'the pool kept the worker that paid',
            );
          } finally {
            stop.abort();
            await settle(clock, [pool], Promise.all(load), 60_000);
          }
        }),
    );

    void test.each(
      [
        { Learning: HillClimbing, units: 3, own: 0 },
        { Learning: Gradient, units: 2, own: 10 },
      ],
      ({ Learning, units, own }) =>
        test(`a ${Learning.name} pool shrinks only after fewer workers did as well in two steps in a row`, async (t) => {
          const clock = createClock();
          const engine = new PQueue({ concurrency: units });
          let thrashing = false;
          const created: EchoWorker[] = [];
          await using pool = new Pool({
            // Four CPUs, and memory for many more workers.
            size: new Learning({
              memoryPerWorker: 1,
              computer: {
                availableParallelism: () => 4,
                availableMemory: () => 2 ** 40,
              },
            }),
            startup: new Parallel(),
            eviction: new NoEviction(),
            create: () => {
              const worker = new EchoWorker();
              worker.release();
              created.push(worker);
              return worker;
            },
            clock,
          });
          const stop = new AbortController();
          const load = Array.from({ length: 16 }, async () => {
            while (!stop.signal.aborted)
              await pool.use(async () => {
                await delay(own, { clock, signal: undefined });
                await engine.add(() =>
                  delay(thrashing ? 30 * engine.pending ** 2 : 50, {
                    clock,
                    signal: undefined,
                  }),
                );
              });
          });
          const timeline: { at: number; lent: number; idle: number }[] = [];
          const sampler = clock.setInterval(() => {
            const { lent, idle } = pool.stats;
            timeline.push({ at: clock.now, lent, idle });
          }, 20);
          try {
            // The pool closes the worker of a step that did not pay: it settled.
            await untilDropped(t, clock, pool, created, 60_000);
            const settled = created.filter((worker) => !worker.dead);

            // The engine thrashes: a job takes longer the more jobs share it,
            // so fewer workers do as well for both sizings.
            thrashing = true;
            engine.concurrency = Infinity;

            await untilDropped(t, clock, pool, settled, 120_000);
            const shrank = timeline.length;
            // A step with fewer workers runs fewer for a whole window and
            // keeps the others alive and idle. A step with one more lends one
            // more, so the steps with fewer after it were in a row.
            let steps = 0;
            let since: number | undefined;
            for (const { at, lent, idle } of timeline.slice(0, shrank)) {
              if (lent > settled.length) {
                steps = 0;
                since = undefined;
              } else if (
                lent < settled.length &&
                lent + idle === settled.length
              )
                since ??= at;
              else {
                if (since !== undefined && at - since >= 1_000) steps++;
                since = undefined;
              }
            }
            assert.equal(steps, 2, `the pool shrank after ${steps} such steps`);

            // The work gets light again: the size the pool left pays again.
            thrashing = false;
            engine.concurrency = units;
            const known = created.length;

            await drive(clock, [pool], () => created.length > known, 90_000);
            const added = created[known]!;
            await runFor(clock, [pool], 15_000);
            await untilExited(t, pool, created);
            assert.equal(
              added.dead,
              false,
              'the pool kept the worker that paid',
            );
          } finally {
            clock.clearInterval(sampler);
            stop.abort();
            await settle(clock, [pool], Promise.all(load), 60_000);
          }
        }),
    );

    void test.each(
      [
        { Learning: HillClimbing, units: 3, own: 0 },
        { Learning: Gradient, units: 2, own: 10 },
      ],
      ({ Learning, units, own }) =>
        test(`a ${Learning.name} pool under steady work starts a worker to try less and less often`, async (t) => {
          const clock = createClock();
          const engine = new PQueue({ concurrency: units });
          const created: EchoWorker[] = [];
          const born = new Map<EchoWorker, number>();
          const died = new Map<EchoWorker, number>();
          await using pool = new Pool({
            // Four CPUs, and memory for many more workers.
            size: new Learning({
              memoryPerWorker: 1,
              computer: {
                availableParallelism: () => 4,
                availableMemory: () => 2 ** 40,
              },
            }),
            startup: new Parallel(),
            eviction: new NoEviction(),
            create: () => {
              const worker = new EchoWorker();
              worker.release();
              created.push(worker);
              born.set(worker, clock.now);
              void worker.exited().then(() => died.set(worker, clock.now));
              return worker;
            },
            clock,
          });
          const stop = new AbortController();
          const load = Array.from({ length: 16 }, async () => {
            while (!stop.signal.aborted)
              await pool.use(async () => {
                await delay(own, { clock, signal: undefined });
                await engine.add(() => delay(50, { clock, signal: undefined }));
              });
          });
          try {
            // The pool closes the worker of a step that did not pay: it settled.
            await untilDropped(t, clock, pool, created, 60_000);
            const settled = created.filter((worker) => !worker.dead);
            const known = created.length;

            // Each worker that a step tries warms up for nothing: a step back
            // to back would start one about every 12 seconds.
            await runFor(clock, [pool], 60_000);

            const now = clock.now;
            const tried = created.slice(known);
            assert.ok(
              tried.length <= 2,
              `the pool started ${tried.length} workers to try`,
            );
            // A step that does not pay closes the worker it tried when the
            // step ends, about two windows after it started the worker.
            for (const worker of tried) {
              const start = born.get(worker)!;
              if (now - start < 10_000) continue;
              const lived = (died.get(worker) ?? now) - start;
              assert.ok(
                lived < 10_000,
                `a worker that a step tried lived ${Math.round(lived)} ms`,
              );
            }
            // No step closed a worker the pool settled on, and each returned
            // to it.
            assert.ok(settled.every((worker) => !worker.dead));
            await drive(
              clock,
              [pool],
              () => pool.stats.lent === settled.length,
              60_000,
            );
          } finally {
            stop.abort();
            await settle(clock, [pool], Promise.all(load), 60_000);
          }
        }),
    );

    test('a hill-climbing pool keeps one more worker that pays in a later step, also while the work gets slower across that step', async (t) => {
      const clock = createClock();
      // Eight units: each worker up to four adds a third of the jobs of three.
      const engine = new PQueue({ concurrency: 8 });
      const created: EchoWorker[] = [];
      await using pool = new Pool({
        // Four CPUs, and memory for many more workers.
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
          const worker = new EchoWorker();
          worker.release();
          created.push(worker);
          return worker;
        },
        clock,
      });
      // A job takes a third longer each two seconds of the clock, as photos
      // follow stickers (ADR 0002): a step that tries four workers measures
      // the jobs of three faster before it and slower after it.
      const stop = new AbortController();
      const load = Array.from({ length: 16 }, async () => {
        while (!stop.signal.aborted)
          await pool.use(() =>
            engine.add(() =>
              delay(50 * (4 / 3) ** (clock.now / 2_000), {
                clock,
                signal: undefined,
              }),
            ),
          );
      });
      try {
        // The first step keeps a third worker, and the next step at once
        // tries a fourth.
        await drive(clock, [pool], () => created.length >= 4, 60_000);
        const fourth = created[3]!;

        // The step measures three again after it tried four, and decides.
        await runFor(clock, [pool], 8_000);
        await untilExited(t, pool, created);

        assert.equal(
          fourth.dead,
          false,
          'the pool closed a fourth worker that paid',
        );
      } finally {
        stop.abort();
        await settle(clock, [pool], Promise.all(load), 120_000);
      }
    });

    test('a hill-climbing pool under steady work stops doubling the pause between two steps at sixteen windows', async () => {
      const clock = createClock();
      // Two units: a third worker adds no jobs, and one worker fewer does
      // worse, so no step changes the size.
      const engine = new PQueue({ concurrency: 2 });
      const tried: number[] = [];
      await using pool = new Pool({
        // Four CPUs, and memory for many more workers.
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
          const worker = new EchoWorker();
          worker.release();
          tried.push(clock.now);
          return worker;
        },
        clock,
      });
      const stop = new AbortController();
      const load = Array.from({ length: 16 }, async () => {
        while (!stop.signal.aborted)
          await pool.use(() =>
            engine.add(() => delay(50, { clock, signal: undefined })),
          );
      });
      try {
        // The first two workers, then a worker for each step with one more.
        // The pause after the n-th step that changes nothing is 2^(n-1)
        // windows of two seconds, at most 16, times 0.5 to 1.5. A step with
        // one more and a step with fewer alternate, so two pauses and two
        // steps of three windows lie between two workers tried.
        await drive(clock, [pool], () => tried.length >= 2 + 9, 1_200_000);

        // From the fifth pause on, each pause is capped: 16 to 48 seconds. The
        // third gap and each one after it hold two capped pauses and six
        // windows of a little more than two seconds: more than 44 seconds and
        // less than 110. A cap of 8 windows gives 28 to 62 seconds, and a cap
        // of 32 gives 76 to 206.
        const gaps = tried
          .slice(2)
          .map((at, index, starts) =>
            index === 0 ? undefined : at - starts[index - 1]!,
          )
          .filter((gap) => gap !== undefined);
        const capped = gaps.slice(2);
        assert.ok(
          capped.every((gap) => gap > 44_000 && gap < 110_000),
          `the gaps between two tried workers were ${gaps.map(Math.round).join(', ')} ms`,
        );
      } finally {
        stop.abort();
        await settle(clock, [pool], Promise.all(load), 120_000);
      }
    });

    void test.each(
      [
        { Learning: HillClimbing, units: 3, own: 0 },
        { Learning: Gradient, units: 2, own: 10 },
      ],
      ({ Learning, units, own }) =>
        test(`a ${Learning.name} pool takes no step while no job waits`, async (t) => {
          const clock = createClock();
          const engine = new PQueue({ concurrency: units });
          const created: EchoWorker[] = [];
          await using pool = new Pool({
            // Four CPUs, and memory for many more workers.
            size: new Learning({
              memoryPerWorker: 1,
              computer: {
                availableParallelism: () => 4,
                availableMemory: () => 2 ** 40,
              },
            }),
            startup: new Parallel(),
            eviction: new NoEviction(),
            create: () => {
              const worker = new EchoWorker();
              worker.release();
              created.push(worker);
              return worker;
            },
            clock,
          });
          const busy = new AbortController();
          const load = Array.from({ length: 16 }, async () => {
            while (!busy.signal.aborted)
              await pool.use(async () => {
                await delay(own, { clock, signal: undefined });
                await engine.add(() => delay(50, { clock, signal: undefined }));
              });
          });
          const quiet = new AbortController();
          try {
            // The pool closes the worker of a step that did not pay: it settled.
            await untilDropped(t, clock, pool, created, 60_000);
            busy.abort();
            await settle(clock, [pool], Promise.all(load), 60_000);
            const settled = created.filter((worker) => !worker.dead);
            const known = created.length;

            // One job at a time: no job waits, so no window says how many pay.
            const trickle = (async () => {
              while (!quiet.signal.aborted)
                await pool.use(() => delay(50, { clock, signal: undefined }));
            })();
            await runFor(clock, [pool], 30_000);
            quiet.abort();
            await settle(clock, [pool], trickle, 60_000);

            assert.equal(created.length, known, 'no step started a worker');
            assert.ok(
              settled.every((worker) => !worker.dead),
              'no step closed a worker',
            );
          } finally {
            busy.abort();
            quiet.abort();
            await settle(clock, [pool], Promise.all(load), 60_000);
          }
        }),
    );

    void test.each(
      [
        { Learning: HillClimbing, units: 3, own: 0 },
        { Learning: Gradient, units: 2, own: 10 },
      ],
      ({ Learning, units, own }) =>
        test(`a ${Learning.name} pool runs fewer workers when the memory they need is no longer free`, async (t) => {
          const clock = createClock();
          const engine = new PQueue({ concurrency: units });
          const created: EchoWorker[] = [];
          // Free memory for eight workers, until other processes take it.
          const memoryPerWorker = 2 ** 30;
          let free = 8 * memoryPerWorker;
          const computer = {
            availableParallelism: () => 4,
            availableMemory: () => free,
          };
          await using pool = new Pool({
            size: new Learning({ memoryPerWorker, computer }),
            startup: new Parallel(),
            eviction: new NoEviction(),
            create: () => {
              const worker = new EchoWorker();
              worker.release();
              created.push(worker);
              return worker;
            },
            clock,
          });
          const stop = new AbortController();
          const load = Array.from({ length: 16 }, async () => {
            while (!stop.signal.aborted)
              await pool.use(async () => {
                await delay(own, { clock, signal: undefined });
                await engine.add(() => delay(50, { clock, signal: undefined }));
              });
          });
          try {
            // The pool closes the worker of a step that did not pay: it settled.
            await untilDropped(t, clock, pool, created, 60_000);
            const settled = created.filter((worker) => !worker.dead);
            assert.ok(
              settled.length > 2,
              `the pool settled at ${settled.length}`,
            );

            // Other processes take the memory: two workers still find theirs free.
            free = 2.5 * memoryPerWorker;

            await drive(
              clock,
              [pool],
              () =>
                settled.filter((worker) => !worker.dead).length === 2 &&
                pool.stats.lent <= 2,
              60_000,
            );
          } finally {
            stop.abort();
            await settle(clock, [pool], Promise.all(load), 60_000);
          }
        }),
    );

    void test.each([HillClimbing, Gradient], (Learning) =>
      test(`a ${Learning.name} pool never runs more workers than the computer affords, also when more would pay`, async (t) => {
        const clock = createClock();
        // Eight units: every worker up to eight adds as much as the one before.
        const engine = new PQueue({ concurrency: 8 });
        const created: EchoWorker[] = [];
        // Free memory for three and a half workers.
        const memoryPerWorker = 2 ** 30;
        const computer = {
          availableParallelism: () => 4,
          availableMemory: () => 3.5 * memoryPerWorker,
        };
        await using pool = new Pool({
          size: new Learning({ memoryPerWorker, computer }),
          startup: new Parallel(),
          eviction: new NoEviction(),
          create: () => {
            const worker = new EchoWorker();
            worker.release();
            created.push(worker);
            return worker;
          },
          clock,
        });
        const stop = new AbortController();
        const load = Array.from({ length: 16 }, async () => {
          while (!stop.signal.aborted)
            await pool.use(() =>
              engine.add(() => delay(50, { clock, signal: undefined })),
            );
        });
        let most = 0;
        const sampler = clock.setInterval(() => {
          most = Math.max(
            most,
            created.filter((worker) => !worker.dead).length,
          );
        }, 20);
        try {
          await drive(clock, [pool], () => pool.stats.lent === 3, 60_000);

          // Steps keep trying sizes while the work runs.
          await runFor(clock, [pool], 40_000);

          assert.equal(most, 3);
        } finally {
          clock.clearInterval(sampler);
          stop.abort();
          await settle(clock, [pool], Promise.all(load), 60_000);
        }
      }),
    );

    test('a Gradient pool measures the time of a job with two workers again, so it shrinks when the work gets heavier for every size', async (t) => {
      // Four units and 10 ms of the job's own: a job takes 60 ms with up to four
      // workers, so the pool grows to the four that the memory affords.
      const clock = createClock();
      const engine = new PQueue({ concurrency: 4 });
      const created: EchoWorker[] = [];
      const memoryPerWorker = 2 ** 30;
      const computer = {
        availableParallelism: () => 4,
        availableMemory: () => 4.5 * memoryPerWorker,
      };
      await using pool = new Pool({
        size: new Gradient({ memoryPerWorker, computer }),
        startup: new Parallel(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new EchoWorker();
          worker.release();
          created.push(worker);
          return worker;
        },
        clock,
      });
      const stop = new AbortController();
      const load = Array.from({ length: 16 }, async () => {
        while (!stop.signal.aborted)
          await pool.use(async () => {
            await delay(10, { clock, signal: undefined });
            await engine.add(() => delay(50, { clock, signal: undefined }));
          });
      });
      try {
        await drive(clock, [pool], () => pool.stats.lent === 4, 60_000);
        const settled = created.filter((worker) => !worker.dead);

        // Two units: a job takes 75 ms with three workers and 100 ms with four,
        // 1.67 times its 60 ms with two. Only a window at two workers shows it,
        // because the time with two that the pool measured before is stale.
        engine.concurrency = 2;

        await untilDropped(t, clock, pool, settled, 120_000);
      } finally {
        stop.abort();
        await settle(clock, [pool], Promise.all(load), 60_000);
      }
    });
  },
);

void test.each(
  [
    { Learning: HillClimbing, units: 3, own: 0 },
    { Learning: Gradient, units: 2, own: 10 },
  ],
  ({ Learning, units, own }) =>
    test(`${Learning.name} pools under the same work do not try one more worker at the same moments`, async () => {
      // Six pools on one clock, as six processes read one time.
      const clock = createClock();
      await using pools = new AsyncDisposableStack();
      const runs = Array.from({ length: 6 }, () => {
        const engine = new PQueue({ concurrency: units });
        const created: { worker: EchoWorker; at: number }[] = [];
        const pool = pools.use(
          new Pool({
            // Four CPUs, and memory for many more workers.
            size: new Learning({
              memoryPerWorker: 1,
              computer: {
                availableParallelism: () => 4,
                availableMemory: () => 2 ** 40,
              },
            }),
            startup: new Parallel(),
            eviction: new NoEviction(),
            create: () => {
              const worker = new EchoWorker();
              worker.release();
              created.push({ worker, at: clock.now });
              return worker;
            },
            clock,
          }),
        );
        return { engine, created, pool };
      });
      const all = runs.map(({ pool }) => pool);
      const stop = new AbortController();
      const load = runs.flatMap(({ engine, pool }) =>
        Array.from({ length: 16 }, async () => {
          while (!stop.signal.aborted)
            await pool.use(async () => {
              await delay(own, { clock, signal: undefined });
              await engine.add(() => delay(50, { clock, signal: undefined }));
            });
        }),
      );
      try {
        // Each pool lets the worker of a step that did not pay go: it settled,
        // and holds one worker fewer at once, before that worker exits. Then
        // it tries one more worker.
        const settled = new Map<number, { at: number; known: number }>();
        const last = all.map((pool) => holds(pool));
        await drive(
          clock,
          all,
          () => {
            for (const [index, { created, pool }] of runs.entries()) {
              const now = holds(pool);
              if (!settled.has(index) && now < last[index]!)
                settled.set(index, { at: clock.now, known: created.length });
              last[index] = now;
            }
            return runs.every(({ created }, index) => {
              const known = settled.get(index)?.known;
              return known !== undefined && created.length > known;
            });
          },
          120_000,
        );
        const delays = runs.map(({ created }, index) => {
          const { at, known } = settled.get(index)!;
          return created[known]!.at - at;
        });

        // Pools that probe in step measure each other's probes, as .NET
        // randomizes its hill climbing for other processes that run it. On
        // one clock, pools with no jitter try one more worker the same time
        // after they settle, to the 10 ms that the clock moves at once.
        const spread = Math.max(...delays) - Math.min(...delays);
        assert.ok(
          spread >= 100,
          `the pools tried one more worker ${delays.join(', ')} ms after they settled`,
        );
      } finally {
        stop.abort();
        await settle(clock, all, Promise.all(load), 60_000);
      }
    }),
);

// A sizing the test steers, which keeps every sample the pool reports.
class Steered implements Sizing {
  readonly ceiling = 2;
  current = 2;
  kept = 2;
  readonly samples: Sample[] = [];

  record(sample: Sample): void {
    this.samples.push(sample);
  }
}

test('a pool keeps alive a worker it stops running while the sizing keeps it, and closes it once the sizing does not', async () => {
  const created: EchoWorker[] = [];
  const sizing = new Steered();
  await using pool = new Pool({
    size: sizing,
    startup: new Parallel(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock: globalThis,
  });
  await pool.ready();
  const run = (text: string) => pool.use((worker) => worker.echo(text));
  assert.deepEqual(await Promise.all([run('a'), run('b')]), ['a', 'b']);

  sizing.current = 1;
  assert.equal(await run('c'), 'c');
  sizing.current = 2;
  assert.deepEqual(await Promise.all([run('d'), run('e')]), ['d', 'e']);
  assert.equal(created.length, 2, 'the kept worker needed no new warm-up');
  assert.ok(created.every((worker) => !worker.dead));

  sizing.current = 1;
  sizing.kept = 1;
  assert.equal(await run('f'), 'f');
  await created[1]!.exited();
  assert.equal(created[0]!.dead, false);
  assert.equal(await run('g'), 'g');
  assert.equal(created.length, 2);
});

test('a job that started before the pool resized does not count toward the new size, and one after does', async () => {
  const sizing = new Steered();
  await using pool = new Pool({
    size: sizing,
    startup: new Parallel(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      return worker;
    },
    clock: globalThis,
  });
  await pool.ready();
  const slow = pool.use((worker) => worker.echo('sleep 400'));
  const fast = pool.use(async (worker) => {
    const text = await worker.echo('sleep 50');
    sizing.current = 1;
    return text;
  });
  // Waiting jobs make the times measurable once the slow job ends.
  const waiting = Array.from({ length: 3 }, () =>
    pool.use((worker) => worker.echo('sleep 10')),
  );

  await Promise.all([slow, fast, ...waiting]);
  const [, beforeResize, afterResize] = sizing.samples;
  assert.equal(beforeResize!.measurable, false);
  assert.equal(afterResize!.measurable, true);
});

test('an eager pool replaces an idle worker that exits on its own, before any job needs it', async (t) => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(2),
    startup: new Parallel(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock: globalThis,
  });
  await pool.ready();

  process.kill(created[0]!.pid, 'SIGKILL');
  await t.waitFor(() => assert.equal(created.length, 3), {
    interval: 10,
    timeout: 5000,
  });
  await created[2]!.ready();

  assert.deepEqual(
    await Promise.all([
      pool.use((worker) => worker.echo('a')),
      pool.use((worker) => worker.echo('b')),
    ]),
    ['a', 'b'],
  );
  assert.equal(created.length, 3);
});

test('stats count the workers that start, wait idle or are lent, and the jobs that wait for one', async (t) => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(2),
    startup: new Parallel(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      created.push(worker);
      return worker;
    },
    clock: globalThis,
  });
  const until = (stats: object) =>
    t.waitFor(() => assert.deepEqual(pool.stats, stats), {
      interval: 10,
      timeout: 5000,
    });
  assert.deepEqual(pool.stats, { starting: 2, idle: 0, lent: 0, waiting: 0 });

  // Two jobs wait for the workers that start, and the third in the queue.
  const gate = new Latch();
  const jobs = ['a', 'b', 'c'].map((text) =>
    pool.use(async (worker) => {
      await gate.wait();
      return worker.echo(text);
    }),
  );
  try {
    await until({ starting: 2, idle: 0, lent: 0, waiting: 3 });

    for (const worker of created) worker.release();
    await until({ starting: 0, idle: 0, lent: 2, waiting: 1 });

    gate.open();
    assert.deepEqual(await Promise.all(jobs), ['a', 'b', 'c']);
    await until({ starting: 0, idle: 2, lent: 0, waiting: 0 });

    // A worker that exits is in no count, and its replacement starts after
    // the back-off.
    created[0]!.kill();
    await until({ starting: 0, idle: 1, lent: 0, waiting: 0 });
    await until({ starting: 1, idle: 1, lent: 0, waiting: 0 });
    created[2]!.release();
    await until({ starting: 0, idle: 2, lent: 0, waiting: 0 });
  } finally {
    // A failed count leaves jobs at the gate or before a worker that warms up;
    // they settle before the pool is disposed, so the count's own error is the
    // one reported.
    for (const worker of created) if (!worker.dead) worker.release();
    gate.open();
    await Promise.allSettled(jobs);
  }
});

test('stats leave out a worker that exits while a job holds it, and a read keeps its values', async (t) => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(1),
    startup: new Parallel(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock: globalThis,
  });
  await pool.ready();
  const gate = new Latch();
  const job = pool.use(async (worker) => {
    await gate.wait();
    return worker.echo('late');
  });
  try {
    await t.waitFor(
      () =>
        assert.deepEqual(pool.stats, {
          starting: 0,
          idle: 0,
          lent: 1,
          waiting: 0,
        }),
      { interval: 10, timeout: 5000 },
    );
    const before = pool.stats;

    created[0]!.kill();
    await t.waitFor(
      () =>
        assert.deepEqual(pool.stats, {
          starting: 0,
          idle: 0,
          lent: 0,
          waiting: 0,
        }),
      { interval: 10, timeout: 5000 },
    );
    assert.deepEqual(before, { starting: 0, idle: 0, lent: 1, waiting: 0 });
    gate.open();
    await assert.rejects(job, /Echo worker exited/);
  } finally {
    gate.open();
    await Promise.allSettled([job]);
  }
});

test('stats leave out an idle worker that exits from an on-demand pool', async (t) => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(1),
    startup: new OnDemand(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock: globalThis,
  });
  assert.equal(await pool.use((worker) => worker.echo('one')), 'one');
  assert.deepEqual(pool.stats, { starting: 0, idle: 1, lent: 0, waiting: 0 });

  created[0]!.kill();
  await t.waitFor(
    () =>
      assert.deepEqual(pool.stats, {
        starting: 0,
        idle: 0,
        lent: 0,
        waiting: 0,
      }),
    { interval: 10, timeout: 5000 },
  );
});

test('an eager pool waits before it replaces a worker that exits early: 1 s, doubled for each early exit in a row, up to 60 s', async () => {
  const clock = createClock();
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(1),
    startup: new Parallel(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock,
  });
  await pool.ready();
  // A minute cannot pass in a test: the test moves the timers instead.

  for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000]) {
    const worker = created.at(-1)!;
    worker.kill();
    await worker.exited();
    await clock.tickAsync(wait - 1);
    assert.deepEqual(
      pool.stats,
      { starting: 0, idle: 0, lent: 0, waiting: 0 },
      `the pool still waits at ${wait - 1} ms`,
    );
    await clock.tickAsync(1);
    assert.equal(pool.stats.starting, 1, `the pool starts at ${wait} ms`);
    assert.equal(await pool.use((next) => next.echo('up')), 'up');
  }
  assert.equal(created.length, 8);
});

test('a job that needs a slot in back-off starts its worker at once, and the back-off starts no other', async () => {
  const clock = createClock();
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(1),
    startup: new Parallel(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock,
  });
  await pool.ready();
  created[0]!.kill();
  await created[0]!.exited();
  assert.deepEqual(pool.stats, { starting: 0, idle: 0, lent: 0, waiting: 0 });

  // The timers do not move, so the job cannot wait out the back-off. A job
  // that waits anyway fails on the real clock of AbortSignal.timeout.
  assert.equal(
    await pool.use((worker) => worker.echo('now'), AbortSignal.timeout(5_000)),
    'now',
  );
  await clock.tickAsync(60_000);
  assert.equal(created.length, 2);
  assert.deepEqual(pool.stats, { starting: 0, idle: 1, lent: 0, waiting: 0 });
});

test('disposing a pool in back-off leaves no timer on its clock', async () => {
  const clock = createClock();
  const created: EchoWorker[] = [];
  const pool = new Pool({
    size: new Fixed(1),
    startup: new Parallel(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock,
  });
  try {
    await pool.ready();
    const timers = () => clock.countTimers();
    const before = timers();
    created[0]!.kill();
    await created[0]!.exited();
    assert.equal(timers(), before + 1, 'the back-off waits on a timer');

    await pool[Symbol.asyncDispose]();
    assert.equal(timers(), before);
  } finally {
    await pool[Symbol.asyncDispose]();
  }
});

test('a worker that ran 10 minutes is replaced at once, and ends the back-off', async () => {
  const clock = createClock();
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(1),
    startup: new Parallel(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock,
  });
  await pool.ready();
  created[0]!.kill();
  await created[0]!.exited();
  await clock.tickAsync(1_000);
  assert.equal(await pool.use((worker) => worker.echo('up')), 'up');

  // The worker runs ten minutes on the clock. No timer of the pool waits.
  await clock.tickAsync(600_000);
  created[1]!.kill();
  await created[1]!.exited();
  assert.equal(pool.stats.starting, 1);
});

test('a slot that the sizing stops keeping during its back-off starts no stray worker once the sizing runs it again', async () => {
  const clock = createClock();
  const created: EchoWorker[] = [];
  const sizing = new Steered();
  await using pool = new Pool({
    size: sizing,
    startup: new Parallel(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock,
  });
  await pool.ready();
  const run = (text: string) => pool.use((worker) => worker.echo(text));
  created[1]!.kill();
  await created[1]!.exited();
  // Slot 1 backs off: its worker is gone and no new one starts yet.
  assert.deepEqual(pool.stats, { starting: 0, idle: 1, lent: 0, waiting: 0 });

  sizing.current = 1;
  sizing.kept = 1;
  assert.equal(await run('a'), 'a');
  sizing.current = 2;
  sizing.kept = 2;
  assert.equal(await run('b'), 'b');
  assert.deepEqual(await Promise.all([run('c'), run('d')]), ['c', 'd']);
  assert.equal(created.length, 3);

  await clock.tickAsync(60_000);
  assert.deepEqual(pool.stats, { starting: 0, idle: 2, lent: 0, waiting: 0 });
  // A stray worker would be created a microtask after its slot starts.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 3);
});

test('an idle worker closes once its idle timeout passes, and not 1 ms sooner, and the stats then count it nowhere', async () => {
  const clock = createClock();
  const created: EchoWorker[] = [];
  // The idle wait starts when the worker becomes ready, so the timers move
  // from before that.
  await using pool = new Pool({
    size: new Fixed(1),
    startup: new Parallel(),
    eviction: new IdleTimeout({ after: 1_000 }),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock,
  });
  await pool.ready();

  await clock.tickAsync(999);
  assert.deepEqual(pool.stats, { starting: 0, idle: 1, lent: 0, waiting: 0 });
  assert.equal(created[0]!.dead, false);

  await clock.tickAsync(1);
  assert.deepEqual(pool.stats, { starting: 0, idle: 0, lent: 0, waiting: 0 });
  await created[0]!.exited();
  assert.equal(created.length, 1);
});

test('a job that takes an idle worker before its idle timeout passes keeps it, and its end starts a new idle timeout', async () => {
  const clock = createClock();
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(1),
    startup: new Parallel(),
    eviction: new IdleTimeout({ after: 1_000 }),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock,
  });
  await pool.ready();

  await clock.tickAsync(999);
  let timersWhileLent: number | undefined;
  assert.equal(
    await pool.use((worker) => {
      timersWhileLent = clock.countTimers();
      return worker.echo('busy');
    }),
    'busy',
  );
  assert.equal(timersWhileLent, 0, 'the job must stop the idle timeout');
  await clock.tickAsync(999);
  assert.deepEqual(pool.stats, { starting: 0, idle: 1, lent: 0, waiting: 0 });
  assert.equal(created[0]!.dead, false);

  await clock.tickAsync(1);
  assert.deepEqual(pool.stats, { starting: 0, idle: 0, lent: 0, waiting: 0 });
  await created[0]!.exited();
  assert.equal(created.length, 1);
});

test('a pool does not evict a worker while a job holds it past its idle timeout, and the end of the job starts a new idle timeout', async (t) => {
  const clock = createClock();
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(1),
    startup: new Parallel(),
    eviction: new IdleTimeout({ after: 1_000 }),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock,
  });
  await pool.ready();
  const gate = new Latch();
  const held = pool.use(async (worker) => {
    await gate.wait();
    return worker.echo('held');
  });
  try {
    await t.waitFor(() => assert.equal(pool.stats.lent, 1));
    await clock.tickAsync(1_001);
    assert.equal(created[0]!.dead, false, 'the lent worker was evicted');
    assert.deepEqual(pool.stats, { starting: 0, idle: 0, lent: 1, waiting: 0 });
  } finally {
    gate.open();
    assert.equal(await held, 'held');
  }

  await clock.tickAsync(999);
  assert.deepEqual(pool.stats, { starting: 0, idle: 1, lent: 0, waiting: 0 });
  await clock.tickAsync(1);
  assert.deepEqual(pool.stats, { starting: 0, idle: 0, lent: 0, waiting: 0 });
  await created[0]!.exited();
});

test('an evicted worker starts no replacement and no back-off, and a job then starts a worker at once, also after a leader-first start', async () => {
  for (const startup of [new Parallel(), new LeaderFirst()]) {
    const clock = createClock();
    const created: EchoWorker[] = [];
    await using pool = new Pool({
      size: new Fixed(2),
      startup,
      eviction: new IdleTimeout({ after: 1_000 }),
      create: () => {
        const worker = new EchoWorker();
        worker.release();
        created.push(worker);
        return worker;
      },
      clock,
    });
    await pool.ready();

    await clock.tickAsync(1_000);
    await Promise.all(created.map((worker) => worker.exited()));
    await clock.tickAsync(60_000);
    assert.equal(created.length, 2, `${startup.constructor.name} replaced`);
    assert.deepEqual(pool.stats, { starting: 0, idle: 0, lent: 0, waiting: 0 });

    // The timers do not move, so a job that waits for a back-off fails on the
    // real clock of AbortSignal.timeout.
    assert.equal(
      await pool.use(
        (worker) => worker.echo('now'),
        AbortSignal.timeout(5_000),
      ),
      'now',
    );
    assert.equal(created.length, 3);
  }
});

test('disposing a pool leaves no idle timeout on its clock', async () => {
  const clock = createClock();
  const timers = () => clock.countTimers();
  const before = timers();
  const pool = new Pool({
    size: new Fixed(1),
    startup: new Parallel(),
    eviction: new IdleTimeout({ after: 60_000 }),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      return worker;
    },
    clock,
  });
  try {
    await pool.ready();
    assert.equal(timers(), before + 1, 'the idle worker waits on a timer');

    await pool[Symbol.asyncDispose]();
    assert.equal(timers(), before);
  } finally {
    await pool[Symbol.asyncDispose]();
  }
});

test('a pool with no eviction keeps its idle workers', async () => {
  const clock = createClock();
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(2),
    startup: new Parallel(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock,
  });
  await pool.ready();

  await clock.tickAsync(3_600_000);
  assert.deepEqual(pool.stats, { starting: 0, idle: 2, lent: 0, waiting: 0 });
  assert.ok(created.every((worker) => !worker.dead));
});

test('a pool does not evict a worker that the sizing keeps but does not run, and evicts it once the sizing runs it again', async (t) => {
  const clock = createClock();
  const created: EchoWorker[] = [];
  const sizing = new Steered();
  await using pool = new Pool({
    size: sizing,
    startup: new Parallel(),
    eviction: new IdleTimeout({ after: 1_000 }),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock,
  });
  await pool.ready();
  const run = (text: string) => pool.use((worker) => worker.echo(text));

  sizing.current = 1;
  assert.equal(await run('a'), 'a');
  // A job holds the worker the pool runs, so only the kept one is idle.
  const gate = new Latch();
  const held = pool.use(async (worker) => {
    await gate.wait();
    return worker.echo('held');
  });
  try {
    await t.waitFor(() => assert.equal(pool.stats.lent, 1));
    await clock.tickAsync(5_000);
    assert.equal(created[1]!.dead, false, 'the kept worker was evicted');
  } finally {
    gate.open();
    assert.equal(await held, 'held');
  }

  sizing.current = 2;
  assert.equal(await run('b'), 'b');
  await clock.tickAsync(999);
  assert.deepEqual(pool.stats, { starting: 0, idle: 2, lent: 0, waiting: 0 });
  await clock.tickAsync(1);
  assert.deepEqual(pool.stats, { starting: 0, idle: 0, lent: 0, waiting: 0 });
  await Promise.all(created.map((worker) => worker.exited()));
  assert.equal(created.length, 2);
});

test('a worker evicted after it ran 10 minutes ends the back-off', async (t) => {
  const clock = createClock();
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(1),
    startup: new Parallel(),
    eviction: new IdleTimeout({ after: 1_000 }),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock,
  });
  await pool.ready();
  // An early exit starts the back-off.
  created[0]!.kill();
  await created[0]!.exited();
  await clock.tickAsync(1_000);

  // A job holds the next worker while it runs ten minutes on the clock, so
  // no idle timeout runs. When the job ends, the idle timeout evicts it.
  const done = Promise.withResolvers<void>();
  const holding = pool.use(async (worker) => {
    await done.promise;
    return worker.echo('up');
  });
  await t.waitFor(() => assert.equal(pool.stats.lent, 1));
  await clock.tickAsync(600_000);
  done.resolve();
  assert.equal(await holding, 'up');
  await clock.tickAsync(1_000);
  await created[1]!.exited();
  assert.equal(await pool.use((worker) => worker.echo('again')), 'again');

  created[2]!.kill();
  await created[2]!.exited();
  await clock.tickAsync(999);
  assert.equal(pool.stats.starting, 0, 'the pool still waits at 999 ms');
  await clock.tickAsync(1);
  assert.equal(pool.stats.starting, 1, 'the pool starts at 1 s, not 2 s');
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

test('a job takes an idle worker before it starts or waits for one in a lower slot', async (t) => {
  await t.test('an empty slot, whose worker failed to start', async (st) => {
    const created: EchoWorker[] = [];
    await using pool = new Pool({
      size: new Fixed(2),
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new EchoWorker();
        if (created.length === 0) worker.fail();
        else worker.release();
        created.push(worker);
        return worker;
      },
      clock: globalThis,
    });
    await assert.rejects(pool.ready(), /Echo worker exited/);
    await st.waitFor(() => assert.ok(pool.stats.idle > 0), {
      interval: 10,
      timeout: 5000,
    });

    assert.equal(await pool.use(async (worker) => worker.pid), created[1]!.pid);
    assert.equal(created.length, 2);
  });

  await t.test('a slot whose worker ended', async () => {
    const created: EchoWorker[] = [];
    await using pool = new Pool({
      size: new Fixed(2),
      startup: new OnDemand(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new EchoWorker();
        worker.release();
        created.push(worker);
        return worker;
      },
      clock: globalThis,
    });
    assert.deepEqual(
      await Promise.all([
        pool.use((worker) => worker.echo('a')),
        pool.use((worker) => worker.echo('b')),
      ]),
      ['a', 'b'],
    );
    created[0]!.kill();
    await created[0]!.exited();

    assert.equal(await pool.use(async (worker) => worker.pid), created[1]!.pid);
    assert.equal(created.length, 2);
  });

  await t.test('a slot in a back-off', async (st) => {
    const clock = createClock();
    const created: EchoWorker[] = [];
    await using pool = new Pool({
      size: new Fixed(2),
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new EchoWorker();
        worker.release();
        created.push(worker);
        return worker;
      },
      clock,
    });
    await pool.ready();
    created[0]!.kill();
    await created[0]!.exited();

    assert.equal(await pool.use(async (worker) => worker.pid), created[1]!.pid);
    assert.equal(created.length, 2);
  });

  await t.test('a slot whose worker still warms up', async (st) => {
    const created: EchoWorker[] = [];
    await using pool = new Pool({
      size: new Fixed(2),
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new EchoWorker();
        if (created.length > 0) worker.release();
        created.push(worker);
        return worker;
      },
      clock: globalThis,
    });
    try {
      await st.waitFor(() => assert.ok(pool.stats.idle > 0), {
        interval: 10,
        timeout: 5000,
      });

      assert.equal(
        await pool.use(
          async (worker) => worker.pid,
          AbortSignal.timeout(5_000),
        ),
        created[1]!.pid,
      );
      assert.equal(created.length, 2);
    } finally {
      created[0]!.release();
    }
  });
});

test('jobs one at a time stay on the lowest idle worker, so the pool evicts the higher idle workers', async () => {
  const clock = createClock();
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(3),
    startup: new Parallel(),
    eviction: new IdleTimeout({ after: 1_000 }),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock,
  });
  await pool.ready();

  for (let job = 0; job < 4; job++) {
    await clock.tickAsync(500);
    assert.equal(await pool.use(async (worker) => worker.pid), created[0]!.pid);
  }
  await Promise.all([created[1]!.exited(), created[2]!.exited()]);
  assert.deepEqual(pool.stats, { starting: 0, idle: 1, lent: 0, waiting: 0 });
  assert.equal(created[0]!.dead, false);
  assert.equal(created.length, 3);
});

test('an eager pool replaces a worker that exits during a job once the job ends, after the back-off of an early exit', async () => {
  const clock = createClock();
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(1),
    startup: new Parallel(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock,
  });
  await pool.ready();

  // The job kills its own worker, as a job with its own time limit does.
  assert.equal(
    await pool.use(async (worker) => {
      worker.kill();
      await worker.exited();
      return 'done';
    }),
    'done',
  );
  await clock.tickAsync(999);
  assert.deepEqual(pool.stats, { starting: 0, idle: 0, lent: 0, waiting: 0 });
  await clock.tickAsync(1);
  assert.equal(pool.stats.starting, 1, 'the pool starts at 1 s');
  // The worker is created a microtask after its slot starts.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 2);
});

test('a job joins a worker that starts before it starts one in an empty slot', async (t) => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(2),
    startup: new OnDemand(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      // Only the first worker waits for the test.
      if (created.length > 0) worker.release();
      created.push(worker);
      return worker;
    },
    clock: globalThis,
  });
  const stop = new AbortController();
  const waiting = pool.use((worker) => worker.echo('never'), stop.signal);
  stop.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.deepEqual(pool.stats, { starting: 1, idle: 0, lent: 0, waiting: 0 });

  const job = pool.use((worker) => worker.echo('joined'));
  try {
    await t.waitFor(() => assert.equal(pool.stats.waiting, 1), {
      interval: 10,
      timeout: 5000,
    });
    created[0]!.release();
    assert.equal(await job, 'joined');
    assert.equal(created.length, 1);
  } finally {
    created[0]!.release();
    await Promise.allSettled([job]);
  }
});

test('a job takes an empty slot before a slot in back-off', async (t) => {
  const clock = createClock();
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(2),
    startup: new Parallel(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      // An eager pool does not start a failed creation again.
      if (created.length === 1) worker.fail();
      else worker.release();
      created.push(worker);
      return worker;
    },
    clock,
  });
  await assert.rejects(pool.ready(), /Echo worker exited/);
  await t.waitFor(() => assert.equal(pool.stats.idle, 1), {
    interval: 10,
    timeout: 5000,
  });
  // An early exit puts the first slot in a back-off of 1 s.
  created[0]!.kill();
  await created[0]!.exited();

  assert.equal(await pool.use((worker) => worker.echo('empty')), 'empty');
  assert.equal(created.length, 3);
  await clock.tickAsync(1_000);
  // The worker is created a microtask after its slot starts.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 4, 'the back-off starts its own worker');
});

test('the pool aborts the signal of an idle wait when a job takes the worker, starts a new wait when the job ends, and aborts it at dispose', async () => {
  const signals: AbortSignal[] = [];
  const pool = new Pool({
    size: new Fixed(1),
    startup: new Parallel(),
    eviction: {
      idle(busy: AbortSignal) {
        signals.push(busy);
      },
    },
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      return worker;
    },
    clock: globalThis,
  });
  try {
    await pool.ready();
    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.aborted, false);

    await pool.use(async (worker) => {
      assert.equal(signals[0]!.aborted, true, 'a job took the worker');
      return worker.echo('busy');
    });
    assert.equal(signals.length, 2);
    assert.equal(signals[1]!.aborted, false);

    await pool[Symbol.asyncDispose]();
    assert.equal(signals[1]!.aborted, true);
  } finally {
    await pool[Symbol.asyncDispose]();
  }
});

/**
 * Moves the fake clock of a pool 10 ms at a time until `done` holds, and lets
 * the event loop turn between two moves, so that the real worker processes
 * that the pool starts and closes report on time. While a worker of a pool
 * starts, the clock waits, so a warm-up takes no time on the clock, as the
 * pool measures no job until its workers are ready. Fails when `limit` ms of
 * the clock pass first.
 */
async function drive(
  clock: ReturnType<typeof createClock>,
  pools: readonly Pool<EchoWorker>[],
  done: () => boolean,
  limit: number,
): Promise<void> {
  const end = clock.now + limit;
  while (!done()) {
    if (clock.now >= end)
      throw new Error(`Not done after ${limit} ms on the clock`);
    if (pools.every((pool) => pool.stats.starting === 0))
      await clock.tickAsync(10);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Moves the fake clock of a pool, as drive does, until the pool lets one of
 * `workers` go: fewer of them run than the pool holds. Then it waits for that
 * worker's real exit with the clock still, so that the pool takes no next
 * step on the clock meanwhile.
 */
async function untilDropped(
  t: TestContext,
  clock: ReturnType<typeof createClock>,
  pool: Pool<EchoWorker>,
  workers: readonly EchoWorker[],
  limit: number,
): Promise<void> {
  await drive(clock, [pool], () => alive(workers) > holds(pool), limit);
  await untilExited(t, pool, workers);
}

/**
 * Waits in real time, with the clock still, until each of `workers` that the
 * pool let go has exited: no more of them run than the pool holds. A worker
 * exits some milliseconds of real time after the pool closes it.
 */
async function untilExited(
  t: TestContext,
  pool: Pool<EchoWorker>,
  workers: readonly EchoWorker[],
): Promise<void> {
  await t.waitFor(() => assert.ok(alive(workers) <= holds(pool)), {
    interval: 5,
    timeout: 10_000,
  });
}

/** The workers that have not exited. */
function alive(workers: readonly EchoWorker[]): number {
  return workers.filter((worker) => !worker.dead).length;
}

/** The workers that the pool holds: those that start, idle or are lent. */
function holds(pool: Pool<EchoWorker>): number {
  const { starting, idle, lent } = pool.stats;
  return starting + idle + lent;
}

/**
 * Moves the fake clock of a pool, as drive does, until `promise` settles: the
 * last job of a load that stopped still waits on the clock.
 */
async function settle<T>(
  clock: ReturnType<typeof createClock>,
  pools: readonly Pool<EchoWorker>[],
  promise: Promise<T>,
  limit: number,
): Promise<T> {
  let settled = false;
  const [value] = await Promise.all([
    promise.finally(() => {
      settled = true;
    }),
    drive(clock, pools, () => settled, limit),
  ]);
  return value;
}

/** Moves the fake clock of a pool `ms` milliseconds, as drive does. */
async function runFor(
  clock: ReturnType<typeof createClock>,
  pools: readonly Pool<EchoWorker>[],
  ms: number,
): Promise<void> {
  const end = clock.now + ms;
  await drive(clock, pools, () => clock.now >= end, ms + 10);
}
