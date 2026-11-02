import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers/promises';

import PQueue from 'p-queue';

import { Latch } from '@zukhruf/async';
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
  for (const [memoryPerWorker, expected] of [
    [Number.MAX_SAFE_INTEGER, 1],
    [1, availableParallelism()],
  ] as const) {
    const created: EchoWorker[] = [];
    await using pool = new Pool({
      size: new Resources({ memoryPerWorker }),
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new EchoWorker();
        worker.release();
        created.push(worker);
        return worker;
      },
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
  const sizing = new HillClimbing({ memoryPerWorker: 1 });
  assert.ok(sizing.ceiling >= 4, 'this test needs four CPUs');
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
  const sizing = new HillClimbing({ memoryPerWorker: 1 });
  assert.ok(sizing.ceiling >= 3, 'this test needs three CPUs');
  // Two workers manage 24 fast files a second at first and 8 slow ones later;
  // three, measured between, manage half again what two do at that point.
  let clock = window(sizing, 0, 24, 1);
  clock = window(sizing, clock, 24, 1);
  window(sizing, clock, 8, 1);
  assert.equal(sizing.current, 3);
});

test('a climbing sizing learns nothing from jobs that were not measurable or from windows under two seconds, and never passes its ceiling', () => {
  const idle = new HillClimbing({ memoryPerWorker: 1 });
  const fast = new Gradient({ memoryPerWorker: 1 });
  for (let job = 0; job < 1000; job++) {
    idle.record({ started: job, finished: job + 1, measurable: false });
    fast.record({ started: job, finished: job + 1, measurable: true });
  }
  assert.deepEqual([idle.current, fast.current], [2, 2]);

  const small = new HillClimbing({ memoryPerWorker: Number.MAX_SAFE_INTEGER });
  assert.equal(small.ceiling, 1);
  window(small, 0, 10, 1);
  assert.deepEqual([small.current, small.kept], [1, 1]);
});

test('gradient keeps one more worker while a job takes at most half again the time it took with two', () => {
  const sizing = new Gradient({ memoryPerWorker: 1 });
  assert.ok(sizing.ceiling >= 4, 'this test needs four CPUs');

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

test('a hill-climbing pool grows past its first two workers while a backlog of slow jobs waits', async () => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    // Room for four workers on any Mac with four CPUs.
    size: new HillClimbing({
      memoryPerWorker: Math.floor(process.availableMemory() / 4),
    }),
    startup: new Parallel(),
    eviction: new NoEviction(),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
  });
  assert.ok(availableParallelism() >= 4, 'this test needs four CPUs');
  await pool.ready();
  assert.equal(created.length, 2);

  // Each job waits 20 ms in its worker, so every worker added adds as much.
  await Promise.all(
    Array.from({ length: 1500 }, () =>
      pool.use((worker) => worker.echo('sleep 20')),
    ),
  );
  assert.ok(created.length > 2, `the pool kept ${created.length} workers`);
});

// These tests wait on real windows of two seconds, so they run at the same
// time. The tests after them replace what the whole process reads, or measure
// timing that other tests would disturb, so they run alone.
void describe(
  'a pool whose sizing keeps learning',
  { concurrency: true },
  () => {
    void test.each([HillClimbing, Gradient], (Learning) =>
      test(`a ${Learning.name} pool that settled grows again when the work changes so that one more worker pays`, async (t) => {
        // The jobs share an engine of a few units, as Vision workers share the
        // Neural Engine: a worker past the units only waits for one.
        const engine = new PQueue({ concurrency: 3 });
        const created: EchoWorker[] = [];
        await using pool = new Pool({
          // One worker for each CPU: free memory, which other processes change,
          // does not decide.
          size: new Learning({ memoryPerWorker: 1 }),
          startup: new Parallel(),
          eviction: new NoEviction(),
          create: () => {
            const worker = new EchoWorker();
            worker.release();
            created.push(worker);
            return worker;
          },
        });
        assert.ok(availableParallelism() >= 8, 'this test needs eight CPUs');
        const stop = new AbortController();
        const load = Array.from({ length: 16 }, async () => {
          while (!stop.signal.aborted)
            await pool.use((worker) =>
              engine.add(() => worker.echo('sleep 50')),
            );
        });
        try {
          // The pool closes the worker of a step that did not pay: it settled.
          await t.waitFor(
            () => assert.ok(created.some((worker) => worker.dead)),
            {
              interval: 50,
              timeout: 60_000,
            },
          );
          const settled = created.filter((worker) => !worker.dead).length;

          engine.concurrency = settled + 2;
          const known = created.length;

          // A step with one more worker starts it. The pool keeps the worker
          // when it pays, and closes it after the step when it does not.
          await t.waitFor(() => assert.ok(created.length > known), {
            interval: 50,
            timeout: 60_000,
          });
          const added = created[known]!;
          await setTimeout(15_000);
          assert.equal(added.dead, false, 'the pool kept the worker that paid');
        } finally {
          stop.abort();
          await Promise.all(load);
        }
      }),
    );

    void test.each([HillClimbing, Gradient], (Learning) =>
      test(`a ${Learning.name} pool shrinks only after fewer workers did as well in two steps in a row`, async (t) => {
        // Three units: neither sizing settles on the edge of its test, so no
        // step that counts toward a shrink comes before the work changes.
        const engine = new PQueue({ concurrency: 3 });
        const created: EchoWorker[] = [];
        await using pool = new Pool({
          // One worker for each CPU: free memory, which other processes change,
          // does not decide.
          size: new Learning({ memoryPerWorker: 1 }),
          startup: new Parallel(),
          eviction: new NoEviction(),
          create: () => {
            const worker = new EchoWorker();
            worker.release();
            created.push(worker);
            return worker;
          },
        });
        assert.ok(availableParallelism() >= 8, 'this test needs eight CPUs');
        const stop = new AbortController();
        const load = Array.from({ length: 16 }, async () => {
          while (!stop.signal.aborted)
            await pool.use((worker) =>
              engine.add(() => worker.echo('sleep 50')),
            );
        });
        const timeline: { at: number; lent: number; idle: number }[] = [];
        const sampler = setInterval(() => {
          const { lent, idle } = pool.stats;
          timeline.push({ at: performance.now(), lent, idle });
        }, 20);
        try {
          // The pool closes the worker of a step that did not pay: it settled.
          await t.waitFor(
            () => assert.ok(created.some((worker) => worker.dead)),
            {
              interval: 50,
              timeout: 60_000,
            },
          );
          const settled = created.filter((worker) => !worker.dead);

          engine.concurrency = 1;

          await t.waitFor(
            () => assert.ok(settled.some((worker) => worker.dead)),
            {
              interval: 50,
              timeout: 120_000,
            },
          );
          const shrank = timeline.length;
          // A step with fewer workers runs fewer for a whole window and keeps
          // the others alive and idle. A step with one more lends one more, so
          // the steps with fewer after it were in a row.
          let steps = 0;
          let since: number | undefined;
          for (const { at, lent, idle } of timeline.slice(0, shrank)) {
            if (lent > settled.length) {
              steps = 0;
              since = undefined;
            } else if (lent < settled.length && lent + idle === settled.length)
              since ??= at;
            else {
              if (since !== undefined && at - since >= 1_000) steps++;
              since = undefined;
            }
          }
          assert.equal(steps, 2, `the pool shrank after ${steps} such steps`);

          // The work gets light again: the size the pool left pays again.
          engine.concurrency = 5;
          const known = created.length;

          await t.waitFor(() => assert.ok(created.length > known), {
            interval: 50,
            timeout: 90_000,
          });
          const added = created[known]!;
          await setTimeout(15_000);
          assert.equal(added.dead, false, 'the pool kept the worker that paid');
        } finally {
          clearInterval(sampler);
          stop.abort();
          await Promise.all(load);
        }
      }),
    );

    void test.each([HillClimbing, Gradient], (Learning) =>
      test(`a ${Learning.name} pool under steady work starts a worker to try less and less often`, async (t) => {
        const engine = new PQueue({ concurrency: 3 });
        const created: EchoWorker[] = [];
        const born = new Map<EchoWorker, number>();
        const died = new Map<EchoWorker, number>();
        await using pool = new Pool({
          // One worker for each CPU: free memory, which other processes change,
          // does not decide.
          size: new Learning({ memoryPerWorker: 1 }),
          startup: new Parallel(),
          eviction: new NoEviction(),
          create: () => {
            const worker = new EchoWorker();
            worker.release();
            created.push(worker);
            born.set(worker, performance.now());
            void worker
              .exited()
              .then(() => died.set(worker, performance.now()));
            return worker;
          },
        });
        assert.ok(availableParallelism() >= 8, 'this test needs eight CPUs');
        const stop = new AbortController();
        const load = Array.from({ length: 16 }, async () => {
          while (!stop.signal.aborted)
            await pool.use((worker) =>
              engine.add(() => worker.echo('sleep 50')),
            );
        });
        try {
          // The pool closes the worker of a step that did not pay: it settled.
          await t.waitFor(
            () => assert.ok(created.some((worker) => worker.dead)),
            {
              interval: 50,
              timeout: 60_000,
            },
          );
          const settled = created.filter((worker) => !worker.dead);
          const known = created.length;

          // Each worker that a step tries warms up for nothing: a step back to
          // back would start one about every 12 seconds.
          await setTimeout(60_000);

          const now = performance.now();
          const tried = created.slice(known);
          assert.ok(
            tried.length <= 2,
            `the pool started ${tried.length} workers to try`,
          );
          // A step that does not pay closes the worker it tried when the step
          // ends, about two windows after it started the worker.
          for (const worker of tried) {
            const start = born.get(worker)!;
            if (now - start < 10_000) continue;
            const lived = (died.get(worker) ?? now) - start;
            assert.ok(
              lived < 10_000,
              `a worker that a step tried lived ${Math.round(lived)} ms`,
            );
          }
          // No step closed a worker the pool settled on, and each returned to it.
          assert.ok(settled.every((worker) => !worker.dead));
          await t.waitFor(() => assert.equal(pool.stats.lent, settled.length), {
            interval: 50,
            timeout: 60_000,
          });
        } finally {
          stop.abort();
          await Promise.all(load);
        }
      }),
    );

    void test.each([HillClimbing, Gradient], (Learning) =>
      test(`a ${Learning.name} pool takes no step while no job waits`, async (t) => {
        const engine = new PQueue({ concurrency: 3 });
        const created: EchoWorker[] = [];
        await using pool = new Pool({
          // One worker for each CPU: free memory, which other processes change,
          // does not decide.
          size: new Learning({ memoryPerWorker: 1 }),
          startup: new Parallel(),
          eviction: new NoEviction(),
          create: () => {
            const worker = new EchoWorker();
            worker.release();
            created.push(worker);
            return worker;
          },
        });
        assert.ok(availableParallelism() >= 8, 'this test needs eight CPUs');
        const busy = new AbortController();
        const load = Array.from({ length: 16 }, async () => {
          while (!busy.signal.aborted)
            await pool.use((worker) =>
              engine.add(() => worker.echo('sleep 50')),
            );
        });
        const quiet = new AbortController();
        try {
          // The pool closes the worker of a step that did not pay: it settled.
          await t.waitFor(
            () => assert.ok(created.some((worker) => worker.dead)),
            {
              interval: 50,
              timeout: 60_000,
            },
          );
          busy.abort();
          await Promise.all(load);
          const settled = created.filter((worker) => !worker.dead);
          const known = created.length;

          // One job at a time: no job waits, so no window says how many pay.
          const trickle = (async () => {
            while (!quiet.signal.aborted)
              await pool.use((worker) => worker.echo('sleep 50'));
          })();
          await setTimeout(30_000);
          quiet.abort();
          await trickle;

          assert.equal(created.length, known, 'no step started a worker');
          assert.ok(
            settled.every((worker) => !worker.dead),
            'no step closed a worker',
          );
        } finally {
          busy.abort();
          quiet.abort();
          await Promise.all(load);
        }
      }),
    );
  },
);

void test.each([HillClimbing, Gradient], (Learning) =>
  test(`a ${Learning.name} pool runs fewer workers when the memory they need is no longer free`, async (t) => {
    const engine = new PQueue({ concurrency: 4 });
    const created: EchoWorker[] = [];
    // Room for eight workers on any Mac with eight CPUs.
    const memoryPerWorker = Math.floor(process.availableMemory() / 8);
    await using pool = new Pool({
      size: new Learning({ memoryPerWorker }),
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new EchoWorker();
        worker.release();
        created.push(worker);
        return worker;
      },
    });
    assert.ok(availableParallelism() >= 8, 'this test needs eight CPUs');
    const stop = new AbortController();
    const load = Array.from({ length: 16 }, async () => {
      while (!stop.signal.aborted)
        await pool.use((worker) => engine.add(() => worker.echo('sleep 50')));
    });
    try {
      // The pool closes the worker of a step that did not pay: it settled.
      await t.waitFor(() => assert.ok(created.some((worker) => worker.dead)), {
        interval: 50,
        timeout: 60_000,
      });
      const settled = created.filter((worker) => !worker.dead);
      assert.ok(settled.length > 2, `the pool settled at ${settled.length}`);

      // Other processes take the memory: two workers still find theirs free.
      t.mock.method(process, 'availableMemory', () => 2.5 * memoryPerWorker);

      await t.waitFor(
        () => {
          assert.equal(settled.filter((worker) => !worker.dead).length, 2);
          assert.ok(pool.stats.lent <= 2);
        },
        { interval: 50, timeout: 60_000 },
      );
    } finally {
      stop.abort();
      await Promise.all(load);
    }
  }),
);

void test.each([HillClimbing, Gradient], (Learning) =>
  test(`${Learning.name} pools under the same work do not try one more worker at the same moments`, async (t) => {
    assert.ok(availableParallelism() >= 8, 'this test needs eight CPUs');
    await using pools = new AsyncDisposableStack();
    const runs = Array.from({ length: 6 }, () => {
      const engine = new PQueue({ concurrency: 3 });
      const created: { worker: EchoWorker; at: number }[] = [];
      const pool = pools.use(
        new Pool({
          // One worker for each CPU: free memory, which other processes
          // change, does not decide.
          size: new Learning({ memoryPerWorker: 1 }),
          startup: new Parallel(),
          eviction: new NoEviction(),
          create: () => {
            const worker = new EchoWorker();
            worker.release();
            created.push({ worker, at: performance.now() });
            return worker;
          },
        }),
      );
      return { engine, created, pool };
    });
    const stop = new AbortController();
    const load = runs.flatMap(({ engine, pool }) =>
      Array.from({ length: 16 }, async () => {
        while (!stop.signal.aborted)
          await pool.use((worker) => engine.add(() => worker.echo('sleep 50')));
      }),
    );
    try {
      const delays = await Promise.all(
        runs.map(async ({ created }) => {
          // The pool closes the worker of a step that did not pay: it settled.
          await t.waitFor(
            () => assert.ok(created.some(({ worker }) => worker.dead)),
            { interval: 50, timeout: 120_000 },
          );
          const settled = performance.now();
          const known = created.length;
          await t.waitFor(() => assert.ok(created.length > known), {
            interval: 50,
            timeout: 120_000,
          });
          return created[known]!.at - settled;
        }),
      );

      // Pools that probe in step measure each other's probes, as .NET
      // randomizes its hill climbing for other processes that run it.
      const spread = Math.max(...delays) - Math.min(...delays);
      assert.ok(
        spread >= 1_000,
        `the pools tried one more worker ${delays.map(Math.round).join(', ')} ms after they settled`,
      );
    } finally {
      stop.abort();
      await Promise.all(load);
    }
  }),
);

void test.each([HillClimbing, Gradient], (Learning) =>
  test(`a ${Learning.name} pool never runs more workers than the Mac affords, also when more would pay`, async (t) => {
    // Eight units: every worker up to eight adds as much as the one before.
    const engine = new PQueue({ concurrency: 8 });
    const created: EchoWorker[] = [];
    await using pool = new Pool({
      // Room for three workers, while other processes take less than a
      // fifth of the free memory.
      size: new Learning({
        memoryPerWorker: Math.floor(process.availableMemory() / 3.9),
      }),
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new EchoWorker();
        worker.release();
        created.push(worker);
        return worker;
      },
    });
    assert.ok(availableParallelism() >= 4, 'this test needs four CPUs');
    const stop = new AbortController();
    const load = Array.from({ length: 16 }, async () => {
      while (!stop.signal.aborted)
        await pool.use((worker) => engine.add(() => worker.echo('sleep 50')));
    });
    let most = 0;
    const sampler = setInterval(() => {
      most = Math.max(most, created.filter((worker) => !worker.dead).length);
    }, 20);
    try {
      await t.waitFor(() => assert.equal(pool.stats.lent, 3), {
        interval: 50,
        timeout: 60_000,
      });

      // Steps keep trying sizes while the work runs.
      await setTimeout(40_000);

      assert.equal(most, 3);
    } finally {
      clearInterval(sampler);
      stop.abort();
      await Promise.all(load);
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

test('an eager pool waits before it replaces a worker that exits early: 1 s, doubled for each early exit in a row, up to 60 s', async (t) => {
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
  });
  await pool.ready();
  // A minute cannot pass in a test: the test moves the timers instead.
  t.mock.timers.enable({ apis: ['setTimeout'] });

  for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000]) {
    const worker = created.at(-1)!;
    worker.kill();
    await worker.exited();
    t.mock.timers.tick(wait - 1);
    assert.deepEqual(
      pool.stats,
      { starting: 0, idle: 0, lent: 0, waiting: 0 },
      `the pool still waits at ${wait - 1} ms`,
    );
    t.mock.timers.tick(1);
    assert.equal(pool.stats.starting, 1, `the pool starts at ${wait} ms`);
    assert.equal(await pool.use((next) => next.echo('up')), 'up');
  }
  assert.equal(created.length, 8);
});

test('a job that needs a slot in back-off starts its worker at once, and the back-off starts no other', async (t) => {
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
  });
  await pool.ready();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  created[0]!.kill();
  await created[0]!.exited();
  assert.deepEqual(pool.stats, { starting: 0, idle: 0, lent: 0, waiting: 0 });

  // The timers do not move, so the job cannot wait out the back-off. A job
  // that waits anyway fails on the real clock of AbortSignal.timeout.
  assert.equal(
    await pool.use((worker) => worker.echo('now'), AbortSignal.timeout(5_000)),
    'now',
  );
  t.mock.timers.tick(60_000);
  assert.equal(created.length, 2);
  assert.deepEqual(pool.stats, { starting: 0, idle: 1, lent: 0, waiting: 0 });
});

test('disposing a pool in back-off leaves no timer that keeps the process alive', async () => {
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
  });
  try {
    await pool.ready();
    const timers = () =>
      process
        .getActiveResourcesInfo()
        .filter((resource) => resource === 'Timeout').length;
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

test('a worker that ran 10 minutes is replaced at once, and ends the back-off', async (t) => {
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
  });
  await pool.ready();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  created[0]!.kill();
  await created[0]!.exited();
  t.mock.timers.tick(1_000);
  assert.equal(await pool.use((worker) => worker.echo('up')), 'up');

  // Ten minutes cannot pass in a test: the clock moves on instead.
  const now = performance.now.bind(performance);
  t.mock.method(performance, 'now', () => now() + 600_000);
  created[1]!.kill();
  await created[1]!.exited();
  assert.equal(pool.stats.starting, 1);
});

test('a slot that the sizing stops keeping during its back-off starts no stray worker once the sizing runs it again', async (t) => {
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
  });
  await pool.ready();
  t.mock.timers.enable({ apis: ['setTimeout'] });
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

  t.mock.timers.tick(60_000);
  assert.deepEqual(pool.stats, { starting: 0, idle: 2, lent: 0, waiting: 0 });
  // A stray worker would be created a microtask after its slot starts.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 3);
});

test('an idle worker closes once its idle timeout passes, and not 1 ms sooner, and the stats then count it nowhere', async (t) => {
  const created: EchoWorker[] = [];
  // The idle wait starts when the worker becomes ready, so the timers move
  // from before that.
  t.mock.timers.enable({ apis: ['setTimeout'] });
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
  });
  await pool.ready();

  t.mock.timers.tick(999);
  assert.deepEqual(pool.stats, { starting: 0, idle: 1, lent: 0, waiting: 0 });
  assert.equal(created[0]!.dead, false);

  t.mock.timers.tick(1);
  assert.deepEqual(pool.stats, { starting: 0, idle: 0, lent: 0, waiting: 0 });
  await created[0]!.exited();
  assert.equal(created.length, 1);
});

test('a job that takes an idle worker before its idle timeout passes keeps it, and its end starts a new idle timeout', async (t) => {
  const created: EchoWorker[] = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
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
  });
  await pool.ready();

  t.mock.timers.tick(999);
  assert.equal(await pool.use((worker) => worker.echo('busy')), 'busy');
  t.mock.timers.tick(999);
  assert.deepEqual(pool.stats, { starting: 0, idle: 1, lent: 0, waiting: 0 });
  assert.equal(created[0]!.dead, false);

  t.mock.timers.tick(1);
  assert.deepEqual(pool.stats, { starting: 0, idle: 0, lent: 0, waiting: 0 });
  await created[0]!.exited();
  assert.equal(created.length, 1);
});

test('a pool does not evict a worker while a job holds it past its idle timeout, and the end of the job starts a new idle timeout', async (t) => {
  const created: EchoWorker[] = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
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
  });
  await pool.ready();
  const gate = new Latch();
  const held = pool.use(async (worker) => {
    await gate.wait();
    return worker.echo('held');
  });
  try {
    // t.waitFor polls with setTimeout, which the mock freezes.
    while (pool.stats.lent === 0)
      await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1_001);
    assert.equal(created[0]!.dead, false, 'the lent worker was evicted');
    assert.deepEqual(pool.stats, { starting: 0, idle: 0, lent: 1, waiting: 0 });
  } finally {
    gate.open();
    assert.equal(await held, 'held');
  }

  t.mock.timers.tick(999);
  assert.deepEqual(pool.stats, { starting: 0, idle: 1, lent: 0, waiting: 0 });
  t.mock.timers.tick(1);
  assert.deepEqual(pool.stats, { starting: 0, idle: 0, lent: 0, waiting: 0 });
  await created[0]!.exited();
});

test('an evicted worker starts no replacement and no back-off, and a job then starts a worker at once, also after a leader-first start', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const startup of [new Parallel(), new LeaderFirst()]) {
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
    });
    await pool.ready();

    t.mock.timers.tick(1_000);
    await Promise.all(created.map((worker) => worker.exited()));
    t.mock.timers.tick(60_000);
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

test('disposing a pool leaves no idle timeout that keeps the process alive', async () => {
  const timers = () =>
    process
      .getActiveResourcesInfo()
      .filter((resource) => resource === 'Timeout').length;
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

test('a pool with no eviction keeps its idle workers', async (t) => {
  const created: EchoWorker[] = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
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
  });
  await pool.ready();

  t.mock.timers.tick(3_600_000);
  assert.deepEqual(pool.stats, { starting: 0, idle: 2, lent: 0, waiting: 0 });
  assert.ok(created.every((worker) => !worker.dead));
});

test('a pool does not evict a worker that the sizing keeps but does not run, and evicts it once the sizing runs it again', async (t) => {
  const created: EchoWorker[] = [];
  const sizing = new Steered();
  t.mock.timers.enable({ apis: ['setTimeout'] });
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
    // t.waitFor polls with setTimeout, which the mock freezes.
    while (pool.stats.lent === 0)
      await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(5_000);
    assert.equal(created[1]!.dead, false, 'the kept worker was evicted');
  } finally {
    gate.open();
    assert.equal(await held, 'held');
  }

  sizing.current = 2;
  assert.equal(await run('b'), 'b');
  t.mock.timers.tick(999);
  assert.deepEqual(pool.stats, { starting: 0, idle: 2, lent: 0, waiting: 0 });
  t.mock.timers.tick(1);
  assert.deepEqual(pool.stats, { starting: 0, idle: 0, lent: 0, waiting: 0 });
  await Promise.all(created.map((worker) => worker.exited()));
  assert.equal(created.length, 2);
});

test('a worker evicted after it ran 10 minutes ends the back-off', async (t) => {
  const created: EchoWorker[] = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
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
  });
  await pool.ready();
  // An early exit starts the back-off.
  created[0]!.kill();
  await created[0]!.exited();
  t.mock.timers.tick(1_000);
  assert.equal(await pool.use((worker) => worker.echo('up')), 'up');

  // Ten minutes cannot pass in a test: the clock moves on instead.
  const now = performance.now.bind(performance);
  t.mock.method(performance, 'now', () => now() + 600_000);
  t.mock.timers.tick(1_000);
  await created[1]!.exited();
  assert.equal(await pool.use((worker) => worker.echo('again')), 'again');

  created[2]!.kill();
  await created[2]!.exited();
  t.mock.timers.tick(999);
  assert.equal(pool.stats.starting, 0, 'the pool still waits at 999 ms');
  t.mock.timers.tick(1);
  assert.equal(pool.stats.starting, 1, 'the pool starts at 1 s, not 2 s');
});

test('an idle timeout throws a RangeError for a time that a timer cannot keep', () => {
  for (const after of [0, Infinity, 2 ** 31])
    assert.throws(() => new IdleTimeout({ after }), RangeError, String(after));
  for (const after of [1, 2_147_483_647])
    assert.doesNotThrow(() => new IdleTimeout({ after }), String(after));
});

test('an idle timeout evicts no worker and keeps no timer when its signal aborted before the call', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let evicted = 0;
    new IdleTimeout({ after: 1_000 }).idle(AbortSignal.abort(), () => {
      evicted++;
    });
    t.mock.timers.tick(1_000);
    assert.equal(evicted, 0);
  } finally {
    t.mock.timers.reset();
  }
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
    });
    await pool.ready();
    st.mock.timers.enable({ apis: ['setTimeout'] });
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

test('jobs one at a time stay on the lowest idle worker, so the pool evicts the higher idle workers', async (t) => {
  const created: EchoWorker[] = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
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
  });
  await pool.ready();

  for (let job = 0; job < 4; job++) {
    t.mock.timers.tick(500);
    assert.equal(await pool.use(async (worker) => worker.pid), created[0]!.pid);
  }
  await Promise.all([created[1]!.exited(), created[2]!.exited()]);
  assert.deepEqual(pool.stats, { starting: 0, idle: 1, lent: 0, waiting: 0 });
  assert.equal(created[0]!.dead, false);
  assert.equal(created.length, 3);
});

test('an eager pool replaces a worker that exits during a job once the job ends, after the back-off of an early exit', async (t) => {
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
  });
  await pool.ready();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  // The job kills its own worker, as a job with its own time limit does.
  assert.equal(
    await pool.use(async (worker) => {
      worker.kill();
      await worker.exited();
      return 'done';
    }),
    'done',
  );
  t.mock.timers.tick(999);
  assert.deepEqual(pool.stats, { starting: 0, idle: 0, lent: 0, waiting: 0 });
  t.mock.timers.tick(1);
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
  });
  await assert.rejects(pool.ready(), /Echo worker exited/);
  await t.waitFor(() => assert.equal(pool.stats.idle, 1), {
    interval: 10,
    timeout: 5000,
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // An early exit puts the first slot in a back-off of 1 s.
  created[0]!.kill();
  await created[0]!.exited();

  assert.equal(await pool.use((worker) => worker.echo('empty')), 'empty');
  assert.equal(created.length, 3);
  t.mock.timers.tick(1_000);
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
