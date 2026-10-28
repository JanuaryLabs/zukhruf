import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { Latch } from '@zukhruf/async';

import {
  Fixed,
  Gradient,
  HillClimbing,
  LeaderFirst,
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

test('a job aborted while it runs kills only its worker, which the next job replaces', async () => {
  const created: EchoWorker[] = [];
  await using pool = new Pool({
    size: new Fixed(2),
    startup: new Parallel(),
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
  assert.equal(created.length, 3);
  await created[0]!.exited();
});

test('a queued job aborted before its turn never runs', async () => {
  await using pool = new Pool({
    size: new Fixed(1),
    startup: new Parallel(),
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
  // Four added only 5%: it keeps three and learns no more.
  assert.deepEqual([sizing.current, sizing.kept], [3, 3]);
  window(sizing, clock, 100, 1);
  assert.deepEqual([sizing.current, sizing.kept], [3, 3]);
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
