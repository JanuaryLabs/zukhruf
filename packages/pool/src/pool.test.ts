import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers/promises';

import { createClock } from '@sinonjs/fake-timers';

import { Latch } from '@zukhruf/async';
import { waitFor } from '@zukhruf/testing/async';
import { test } from '@zukhruf/testing/node';

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

class EchoWorker implements Worker<string, string> {
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

  run(text: string): Promise<string> {
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
  const hung = pool.use((worker) => worker.run('hang'), stop.signal);
  const other = pool.use((worker) => worker.run('other'));
  await setTimeout(100);

  stop.abort(reason);
  await assert.rejects(hung, (error) => error === reason);
  assert.equal(await other, 'other');
  assert.equal(created[0]!.dead, true);
  assert.equal(created[1]!.dead, false);

  assert.equal(await pool.use((worker) => worker.run('next')), 'next');
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
    return worker.run('busy');
  });
  let ran = false;
  const stop = new AbortController();
  const queued = pool.use(async (worker) => {
    ran = true;
    return worker.run('queued');
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
  const waiting = pool.use((worker) => worker.run('never'), stop.signal);

  stop.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(created[0]!.dead, false);

  created[0]!.release();
  await pool.ready();
  assert.equal(await pool.use((worker) => worker.run('later')), 'later');
  assert.equal(created.length, 1);
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
  await waitFor(() => assert.equal(created.length, 1), {
    signal: t.signal,
    interval: 10,
  });
  const ready = assert.rejects(pool.ready());
  const jobs = Promise.allSettled(
    Array.from({ length: 3 }, () => pool.use((worker) => worker.run('x'))),
  );

  await pool[Symbol.asyncDispose]();
  await ready;
  assert.deepEqual(
    (await jobs).map(({ status }) => status),
    ['rejected', 'rejected', 'rejected'],
  );
  await assert.rejects(
    pool.use((worker) => worker.run('after')),
    { name: 'AbortError' },
  );
  assert.equal(created.length, 1, 'the second worker must never start');
  assert.ok(created.every((worker) => worker.dead));
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
  await t.test('an empty slot, whose worker the eviction let go', async () => {
    const clock = createClock();
    const created: EchoWorker[] = [];
    await using pool = new Pool({
      size: new Fixed(2),
      startup: new Parallel(),
      eviction: new IdleTimeout({ after: 60_000 }),
      create: () => {
        const worker = new EchoWorker();
        worker.release();
        created.push(worker);
        return worker;
      },
      clock,
    });
    await pool.ready();
    // Two jobs hold both workers. The first job ends, and the eviction lets
    // its idle worker go while the second job holds the other one.
    const first = new Latch();
    const second = new Latch();
    const jobs = [pool.use(() => first.wait()), pool.use(() => second.wait())];
    first.open();
    await jobs[0];
    await clock.tickAsync(60_000);
    await created[0]!.exited();
    second.open();
    await jobs[1];

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
        pool.use((worker) => worker.run('a')),
        pool.use((worker) => worker.run('b')),
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
      await waitFor(() => assert.ok(pool.stats.idle > 0), {
        signal: st.signal,
        interval: 10,
      });

      assert.equal(
        await pool.use(async (worker) => worker.pid, st.signal),
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
  const waiting = pool.use((worker) => worker.run('never'), stop.signal);
  stop.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.deepEqual(pool.stats, { starting: 1, idle: 0, lent: 0, waiting: 0 });

  const job = pool.use((worker) => worker.run('joined'));
  try {
    await waitFor(() => assert.equal(pool.stats.waiting, 1), {
      signal: t.signal,
      interval: 10,
    });
    created[0]!.release();
    assert.equal(await job, 'joined');
    assert.equal(created.length, 1);
  } finally {
    created[0]!.release();
    await Promise.allSettled([job]);
  }
});

test('a job takes an empty slot before a slot in back-off', async () => {
  const clock = createClock();
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(2),
    startup: new Parallel(),
    eviction: new IdleTimeout({ after: 60_000 }),
    create: () => {
      const worker = new EchoWorker();
      worker.release();
      created.push(worker);
      return worker;
    },
    clock,
  });
  await pool.ready();
  // A job holds the first worker while the eviction lets the idle second one
  // go, which leaves its slot empty.
  const held = pool.use((worker) => worker.run('hang'));
  await clock.tickAsync(60_000);
  await created[1]!.exited();
  // An early exit during the job puts the first slot in a back-off of 1 s
  // once the job ends.
  created[0]!.kill();
  await assert.rejects(held, /Echo worker exited/);

  assert.equal(await pool.use((worker) => worker.run('empty')), 'empty');
  assert.equal(created.length, 3);
  await clock.tickAsync(1_000);
  // The worker is created a microtask after its slot starts.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 4, 'the back-off starts its own worker');
});
