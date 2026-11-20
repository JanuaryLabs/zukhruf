import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { createClock } from '@sinonjs/fake-timers';
import PQueue from 'p-queue';

import { Latch, type WallClock, delay, untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { open } from '@zukhruf/sqlite-open';
import {
  SqliteJobQueue,
  type SqliteJobQueueOptions,
} from '@zukhruf/sqlite-queue';
import { waitFor } from '@zukhruf/testing/async';
import { describe, test } from '@zukhruf/testing/node';

import {
  DisposedError,
  type Eviction,
  Fixed,
  Gradient,
  HillClimbing,
  IdleTimeout,
  JobCancelledError,
  JobFailedError,
  JobNotFoundError,
  LeaderFirst,
  NoEviction,
  OnDemand,
  OrderedReady,
  Parallel,
  Pool,
  PoolWorkers,
  Resources,
  type Sample,
  type Sizing,
  type Startup,
  type Worker,
  WorkerKind,
} from './index.ts';

// The queue of the kind that each host builds: "echo", revision 1.
const queue = 'echo.r1';

// A host: a program that builds PoolWorkers of the "echo" kind on the store
// of argv[1], with the settings of argv[2], and reports to the test over IPC.
// Its workers live in the host: run reports the job and answers with the
// host's pid after input.ms, throws input.fail, and never answers in the host
// whose pid is input.hangIn. A worker of a host with closeHangs never ends
// its close. "dispose" disposes the PoolWorkers; a lingering host then stays
// alive. A host with settings.call is a caller instead: it builds a Pool of
// the kind, runs that input (or only starts it, with settings.start), and
// reports once it sent the job.
const host = `
import { setTimeout as sleep } from 'node:timers/promises';
import { Fixed, NoEviction, Parallel, Pool, PoolWorkers, WorkerKind } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};

const [store, json] = process.argv.slice(1);
const settings = JSON.parse(json);

if (settings.call) {
  const pool = new Pool({
    kind: new WorkerKind({ name: 'echo', revision: 1, policy: settings.policy ?? 'standard', retryLimit: settings.retryLimit, expireInSeconds: 60 }),
    store,
    clock: globalThis,
  });
  if (settings.start) await pool.start(settings.call);
  else void pool.run(settings.call).catch(() => {});
  process.send({ called: true });
  setInterval(() => {}, 60_000);
} else {

class HostWorker {
  #exit = Promise.withResolvers();
  async run(input) {
    process.send({ started: input.id });
    if (input.hangIn === process.pid) await new Promise(() => {});
    if (input.fail) throw new Error(input.fail);
    await sleep(input.ms ?? 0);
    return { host: process.pid, id: input.id };
  }
  exited() { return this.#exit.promise; }
  kill() { this.#exit.resolve(); }
  async close() {
    this.#exit.resolve();
    if (settings.closeHangs) await new Promise(() => {});
  }
}

let workers;
try {
  workers = new PoolWorkers({
    kind: new WorkerKind({ name: 'echo', revision: 1, policy: settings.policy ?? 'standard', retryLimit: settings.retryLimit, expireInSeconds: 60 }),
    store,
    clock: globalThis,
    create: () => {
      process.send({ created: true });
      return new HostWorker();
    },
    size: new Fixed(settings.workers),
    startup: new Parallel(),
    eviction: new NoEviction(),
  });
} catch (error) {
  process.send({ refused: error.name });
  process.exit(1);
}
process.send({ constructed: true });
process.once('message', async () => {
  await workers[Symbol.asyncDispose]();
  if (settings.linger) setInterval(() => {}, 60_000);
  process.send({ disposed: true });
});
}
`;

type Report =
  | { created: true }
  | { constructed: true }
  | { started: string }
  | { refused: string }
  | { disposed: true }
  | { called: true };

/** A host process; its disposal kills it when it still runs. */
class Host implements AsyncDisposable {
  readonly reports: Report[] = [];
  readonly #child: ChildProcess;
  readonly #exit = new Latch<number | null>();

  constructor(
    store: string,
    settings: {
      workers: number;
      retryLimit: number;
      policy?: 'standard' | 'exclusive';
      linger?: boolean;
      closeHangs?: boolean;
      call?: { id: string };
      start?: boolean;
    },
    cwd?: string,
  ) {
    this.#child = spawn(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '--eval',
        host,
        store,
        JSON.stringify(settings),
      ],
      { cwd, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    );
    this.#child.on('message', (report: Report) => this.reports.push(report));
    this.#child.once('close', (code: number | null) => this.#exit.open(code));
  }

  /** Resolves with the exit code once the process ended, or null after a signal. */
  closed(): Promise<number | null> {
    return this.#exit.wait();
  }

  get pid(): number {
    return this.#child.pid!;
  }

  get running(): boolean {
    return this.#child.exitCode === null && this.#child.signalCode === null;
  }

  /** Resolves with the first report that matches, as soon as it arrives. */
  async report(
    match: (report: Report) => boolean,
    { signal }: { signal: AbortSignal },
  ): Promise<Report> {
    const found = this.reports.find(match);
    if (found) return found;
    const arrived = Promise.withResolvers<Report>();
    const listener = (report: Report) => {
      if (match(report)) arrived.resolve(report);
    };
    this.#child.on('message', listener);
    try {
      return await untilAborted(arrived.promise, signal);
    } finally {
      this.#child.off('message', listener);
    }
  }

  send(message: string): void {
    this.#child.send(message);
  }

  kill(): void {
    this.#child.kill('SIGKILL');
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.running) this.kill();
    await this.closed();
  }
}

/** The kind that each host builds, as the host program does, for a Pool of the test. */
function hostKind(settings: {
  retryLimit: number;
}): WorkerKind<
  { id: string; ms?: number; fail?: string; hangIn?: number },
  { host: number; id: string }
> {
  return new WorkerKind({
    name: 'echo',
    revision: 1,
    policy: 'standard',
    retryLimit: settings.retryLimit,
    expireInSeconds: 60,
  });
}

/**
 * The test's own connection to the store, as a host that only sends. On a
 * fake clock it stamps its jobs with the time of the owner's clock.
 */
async function sender(store: string, clock?: FakeClock) {
  const jobs = await new SqliteJobQueue({
    path: store,
    supervise: false,
    schedule: false,
    ...(clock && { clock: bossClock(clock) }),
  }).start();
  return { jobs, [Symbol.asyncDispose]: () => jobs.stop() };
}

const owns = (report: Report) => 'created' in report;
const constructed = (report: Report) => 'constructed' in report;

describe('PoolWorkers', { concurrency: true }, () => {
  test('a host whose store is a postgres:// address is refused and opens no file', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    await using refused = new Host(
      'postgres://localhost/pool',
      { workers: 1, retryLimit: 0 },
      folder.path,
    );

    const report = await refused.report((report) => 'refused' in report, {
      signal: t.signal,
    });

    assert.deepEqual(report, { refused: 'TypeError' });
    assert.equal(await refused.closed(), 1);
    assert.deepEqual(await readdir(folder.path, { recursive: true }), []);
  });

  test("a host whose kind's expireInSeconds the store refuses rejects its disposal with the store's failure", async () => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const host = new PoolWorkers({
      kind: new WorkerKind<{ id: string }, { id: string }>({
        name: 'echo',
        revision: 1,
        policy: 'standard',
        retryLimit: 0,
        expireInSeconds: 25 * 60 * 60,
      }),
      store: join(folder.path, 'store.sqlite'),
      clock: globalThis,
      create: new HeldWorkers().create,
      size: new Fixed(1),
      startup: new Parallel(),
      eviction: new NoEviction(),
    });

    await assert.rejects(
      host[Symbol.asyncDispose](),
      /expiration cannot exceed 24 hours/,
    );
  });

  test('of two hosts on one store, only the owner starts workers and runs the jobs', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    // Disposed after the hosts, so it removes the pipe of the last owner.
    await using _successor = succeedLastOwner(store);
    await using owner = new Host(store, { workers: 2, retryLimit: 0 });
    await owner.report(owns, { signal: t.signal });
    await using standby = new Host(store, { workers: 2, retryLimit: 0 });
    await standby.report(constructed, { signal: t.signal });
    await using pool = new Pool({
      kind: hostKind({ retryLimit: 0 }),
      store,
      clock: globalThis,
    });
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];

    const outputs = await Promise.all(
      ids.map((id) => pool.run({ id, ms: 200 })),
    );

    assert.deepEqual(
      outputs,
      ids.map((id) => ({ host: owner.pid, id })),
    );
    assert.deepEqual(standby.reports, [{ constructed: true }]);
  });

  test("the owner creates the kind's queue with the kind's rules and a heartbeat of 10 s", async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    // Disposed after the hosts, so it removes the pipe of the last owner.
    await using _successor = succeedLastOwner(store);
    await using owner = new Host(store, {
      workers: 1,
      retryLimit: 3,
      policy: 'exclusive',
    });
    await owner.report(owns, { signal: t.signal });
    await using sending = await sender(store);

    const id = await sending.jobs.send(queue, { input: { id: 'a' } });

    const [job] = await sending.jobs.findJobs(queue, { id: id! });
    assert.deepEqual(
      [
        job?.policy,
        job?.retryLimit,
        job?.expireInSeconds,
        job?.heartbeatSeconds,
      ],
      ['exclusive', 3, 60, 10],
    );
  });

  test('the owner completes a job with its output, and fails a job whose worker throws with its name and message', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    // Disposed after the hosts, so it removes the pipe of the last owner.
    await using _successor = succeedLastOwner(store);
    await using owner = new Host(store, { workers: 2, retryLimit: 0 });
    await owner.report(owns, { signal: t.signal });
    await using pool = new Pool({
      kind: hostKind({ retryLimit: 0 }),
      store,
      clock: globalThis,
    });

    const [done, broken] = await Promise.allSettled([
      pool.run({ id: 'done' }),
      pool.run({ id: 'broken', fail: 'boom' }),
    ]);

    assert.deepEqual(done, {
      status: 'fulfilled',
      value: { host: owner.pid, id: 'done' },
    });
    assert.equal(broken.status, 'rejected');
    assert.ok(broken.reason instanceof JobFailedError);
    assert.deepEqual(broken.reason.failure, { name: 'Error', message: 'boom' });
  });

  test('with Fixed(2), the store never holds more than 2 active jobs, and holds 2 at once', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    // Disposed after the hosts, so it removes the pipe of the last owner.
    await using _successor = succeedLastOwner(store);
    await using owner = new Host(store, { workers: 2, retryLimit: 0 });
    await owner.report(owns, { signal: t.signal });
    await using pool = new Pool({
      kind: hostKind({ retryLimit: 0 }),
      store,
      clock: globalThis,
    });
    await using sending = await sender(store);

    // The owner hears of each job while both workers are busy, and runs
    // longer than its backstop. The second job runs longer than the first,
    // so one worker becomes free while the other still runs.
    await Promise.all(
      (
        [
          ['a', 1_500],
          ['b', 2_200],
          ['c', 1_500],
          ['d', 1_500],
          ['e', 1_500],
        ] as const
      ).map(([id, ms]) => pool.run({ id, ms })),
    );

    const jobs = await settled(t, sending.jobs, 5);
    // A fetched job is active from its startedOn until its completedOn.
    const moments = jobs.flatMap(({ startedOn, completedOn }) => [
      { at: startedOn!.getTime(), change: 1 },
      { at: completedOn!.getTime(), change: -1 },
    ]);
    moments.sort((a, b) => a.at - b.at || a.change - b.change);
    let active = 0;
    let most = 0;
    for (const { change } of moments) most = Math.max(most, (active += change));
    assert.equal(most, 2);
  });

  test('after a SIGKILL of the owner while it runs a job, the standby owns and runs that job', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    // Disposed after the hosts, so it removes the pipe of the last owner.
    await using _successor = succeedLastOwner(store);
    await using owner = new Host(store, { workers: 1, retryLimit: 1 });
    await owner.report(owns, { signal: t.signal });
    await using standby = new Host(store, { workers: 1, retryLimit: 1 });
    await standby.report(constructed, { signal: t.signal });
    await using pool = new Pool({
      kind: hostKind({ retryLimit: 1 }),
      store,
      clock: globalThis,
    });
    const held = await pool.start({ id: 'held', hangIn: owner.pid });
    await owner.report((report) => 'started' in report, { signal: t.signal });

    owner.kill();
    await owner.closed();

    // The job comes back by its heartbeat of 10 s, found by a supervise and
    // monitor pass each second: the defaults of 60 s miss this bound.
    assert.deepEqual(await held.result(), { host: standby.pid, id: 'held' });
  });

  test('an owner that disposes finishes its running job, then resigns while its process lives', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    // Disposed after the hosts, so it removes the pipe of the last owner.
    await using _successor = succeedLastOwner(store);
    await using owner = new Host(store, {
      workers: 1,
      retryLimit: 0,
      linger: true,
    });
    await owner.report(owns, { signal: t.signal });
    await using standby = new Host(store, { workers: 1, retryLimit: 0 });
    await standby.report(constructed, { signal: t.signal });
    await using pool = new Pool({
      kind: hostKind({ retryLimit: 0 }),
      store,
      clock: globalThis,
    });
    const running = await pool.start({ id: 'running', ms: 1_000 });
    await owner.report((report) => 'started' in report, { signal: t.signal });

    owner.send('dispose');
    await owner.report((report) => 'disposed' in report, { signal: t.signal });

    assert.deepEqual(await pool.run({ id: 'next' }), {
      host: standby.pid,
      id: 'next',
    });
    assert.deepEqual(await running.result(), {
      host: owner.pid,
      id: 'running',
    });
    assert.equal(owner.running, true);
  });

  test('an owner that disposes resigns once its running job ends, before its workers close', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    // Disposed after the hosts, so it removes the pipe of the last owner.
    await using _successor = succeedLastOwner(store);
    await using owner = new Host(store, {
      workers: 1,
      retryLimit: 0,
      closeHangs: true,
    });
    await owner.report(owns, { signal: t.signal });
    await using standby = new Host(store, { workers: 1, retryLimit: 0 });
    await standby.report(constructed, { signal: t.signal });
    await using pool = new Pool({
      kind: hostKind({ retryLimit: 0 }),
      store,
      clock: globalThis,
    });
    await using sending = await sender(store);
    const running = await pool.start({ id: 'running', ms: 500 });
    await owner.report((report) => 'started' in report, { signal: t.signal });

    owner.send('dispose');
    await standby.report(owns, { signal: t.signal });
    const [whenOwned] = await sending.jobs.findJobs(queue, { id: running.id });
    assert.equal(whenOwned?.state, 'completed');

    assert.deepEqual(await pool.run({ id: 'next' }), {
      host: standby.pid,
      id: 'next',
    });
    assert.deepEqual(await running.result(), {
      host: owner.pid,
      id: 'running',
    });
    assert.equal(
      owner.reports.some((report) => 'disposed' in report),
      false,
    );
  });

  test('a host that disposes its PoolWorkers exits by itself', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    await using owner = new Host(store, { workers: 1, retryLimit: 0 });
    await owner.report(owns, { signal: t.signal });

    owner.send('dispose');

    assert.equal(await untilAborted(owner.closed(), t.signal), 0);
  });
});

// The owner in the test process, with real worker processes on the real
// clock, and a Pool that sends the jobs.
describe('PoolWorkers lends its workers', { concurrency: true }, () => {
  test('an on-demand owner starts no worker until a job needs one, then reuses it', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const created: EchoWorker[] = [];
    await using workers = lending(store, {
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
    await using pool = new Pool({ kind: echo(), store, clock: globalThis });
    await workers.ready();
    assert.equal(created.length, 0);

    assert.equal(await pool.run('one'), 'one');
    assert.equal(await pool.run('two'), 'two');
    assert.equal(created.length, 1);

    assert.deepEqual(
      await Promise.all([pool.run('a'), pool.run('b'), pool.run('c')]),
      ['a', 'b', 'c'],
    );
    assert.equal(created.length, 2);
  });

  test('a parallel owner starts every worker at once', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const created: EchoWorker[] = [];
    await using workers = lending(join(folder.path, 'store.sqlite'), {
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
    await waitFor(() => assert.equal(created.length, 3), {
      signal: t.signal,
      interval: 10,
    });
    for (const worker of created) worker.release();
    await workers.ready();
  });

  test('an ordered-ready owner starts each worker after the previous one is ready', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const created: EchoWorker[] = [];
    await using workers = lending(join(folder.path, 'store.sqlite'), {
      size: new Fixed(3),
      startup: new OrderedReady(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new EchoWorker();
        created.push(worker);
        return worker;
      },
    });
    await waitFor(() => assert.equal(created.length, 1), {
      signal: t.signal,
      interval: 10,
    });
    await setTimeout(200);
    assert.equal(created.length, 1);

    created[0]!.release();
    await waitFor(() => assert.equal(created.length, 2), {
      signal: t.signal,
      interval: 10,
    });
    await setTimeout(200);
    assert.equal(created.length, 2);

    created[1]!.release();
    await waitFor(() => assert.equal(created.length, 3), {
      signal: t.signal,
      interval: 10,
    });
    created[2]!.release();
    await workers.ready();
  });

  test('a leader-first owner starts the others together once the first is ready, and replaces a crashed worker at once', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const created: EchoWorker[] = [];
    await using workers = lending(store, {
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
    await using pool = new Pool({ kind: echo(), store, clock: globalThis });
    await waitFor(() => assert.equal(created.length, 1), {
      signal: t.signal,
      interval: 10,
    });
    const job = pool.run('during warm-up');
    await setTimeout(200);
    assert.equal(created.length, 1, 'no worker may start beside the leader');

    created[0]!.release();
    await workers.ready();
    assert.equal(created.length, 3);
    assert.equal(await job, 'during warm-up');

    process.kill(created[1]!.pid, 'SIGKILL');
    await created[1]!.exited();
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, index) => pool.run(String(index))),
    );
    assert.deepEqual(results, ['0', '1', '2']);
    assert.equal(created.length, 4);
  });

  test('a worker that fails to start fails the job waiting for it, and the next job starts another', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const created: EchoWorker[] = [];
    await using workers = lending(store, {
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
    await using pool = new Pool({ kind: echo(), store, clock: globalThis });

    await assert.rejects(pool.run('first'), /Echo worker exited/);
    assert.equal(await pool.run('second'), 'second');
    assert.equal(created.length, 2);
  });

  test('a resources sizing runs one worker per CPU while each finds its memory free, and at least one', async () => {
    for (const [cpus, gibFree, expected] of [
      [3, 64, 3],
      [8, 2.5, 2],
      [4, 0.5, 1],
    ] as const) {
      await using folder = await new TemporaryFiles().directory('pool-');
      const created: EchoWorker[] = [];
      await using workers = lending(join(folder.path, 'store.sqlite'), {
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
      });
      await workers.ready();
      assert.equal(created.length, expected);
    }
  });

  test('an owner keeps alive a worker it stops running while the sizing keeps it, and closes it once the sizing does not', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const created: EchoWorker[] = [];
    const sizing = new Steered();
    await using workers = lending(store, {
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
    await using pool = new Pool({ kind: echo(), store, clock: globalThis });
    await workers.ready();
    const run = (text: string) => pool.run(text);
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

  test('a job that started before the owner resized does not count toward the new size, and one after does', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const sizing = new Steered();
    // The fast job resizes once its line comes back, while the slow job runs.
    class Resizing extends EchoWorker {
      override async run(text: string): Promise<string> {
        const echoed = await super.run(text);
        if (text === 'sleep 50') sizing.current = 1;
        return echoed;
      }
    }
    const created: EchoWorker[] = [];
    await using workers = lending(store, {
      size: sizing,
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new Resizing();
        created.push(worker);
        return worker;
      },
    });
    await using pool = new Pool({ kind: echo(), store, clock: globalThis });
    await waitFor(() => assert.equal(created.length, 2), {
      signal: t.signal,
      interval: 10,
    });
    // One at a time, so the store gives the slow and the fast job first.
    const handles = await Array.fromAsync(
      ['sleep 400', 'sleep 50', 'sleep 10', 'sleep 10', 'sleep 10'],
      (text) => pool.start(text),
    );
    // The owner fetched the slow and the fast job for its two workers, which
    // warm up until the test releases them, so both jobs start together.
    // Waiting jobs make the times measurable once the slow job ends.
    await waitFor(() => assert.equal(workers.stats.waiting, 2), {
      signal: t.signal,
      interval: 10,
    });
    for (const worker of created) worker.release();

    await Promise.all(handles.map((handle) => handle.result()));
    const [, beforeResize, afterResize] = sizing.samples;
    assert.equal(beforeResize!.measurable, false);
    assert.equal(afterResize!.measurable, true);
  });

  test('an eager owner replaces an idle worker that exits on its own, before any job needs it', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const created: EchoWorker[] = [];
    await using workers = lending(store, {
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
    await using pool = new Pool({ kind: echo(), store, clock: globalThis });
    await workers.ready();

    process.kill(created[0]!.pid, 'SIGKILL');
    await waitFor(() => assert.equal(created.length, 3), {
      signal: t.signal,
      interval: 10,
    });
    await created[2]!.ready();

    assert.deepEqual(await Promise.all([pool.run('a'), pool.run('b')]), [
      'a',
      'b',
    ]);
    assert.equal(created.length, 3);
  });

  test('stats count the workers that start, wait idle or are lent, and the jobs that wait for one', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const gate = new Latch();
    // A job holds its worker at the gate before it runs.
    class Gated extends EchoWorker {
      override async run(text: string): Promise<string> {
        await gate.wait();
        return super.run(text);
      }
    }
    const created: EchoWorker[] = [];
    await using workers = lending(store, {
      size: new Fixed(2),
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new Gated();
        created.push(worker);
        return worker;
      },
    });
    await using pool = new Pool({ kind: echo(), store, clock: globalThis });
    await using sending = await sender(store);
    const until = (stats: object) =>
      waitFor(() => assert.deepEqual(workers.stats, stats), {
        signal: t.signal,
        interval: 10,
      });
    await until({ starting: 2, idle: 0, lent: 0, waiting: 0 });

    // The owner takes two jobs for the workers that start; the third waits in
    // the store, not in the owner.
    const handles = await Array.fromAsync(['a', 'b', 'c'], (text) =>
      pool.start(text),
    );
    const jobs = handles.map((handle) => handle.result());
    try {
      await until({ starting: 2, idle: 0, lent: 0, waiting: 2 });
      assert.deepEqual(
        (await sending.jobs.findJobs(queue))
          .map(({ state }) => state)
          .toSorted(),
        ['active', 'active', 'created'],
      );

      for (const worker of created) worker.release();
      await until({ starting: 0, idle: 0, lent: 2, waiting: 0 });

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
      // A failed count leaves jobs at the gate or before a worker that warms
      // up; they settle before the owner disposes, so the count's own error
      // is the one reported.
      for (const worker of created) if (!worker.dead) worker.release();
      gate.open();
      await Promise.allSettled(jobs);
    }
  });

  test('stats leave out a worker that exits while a job holds it, and a read keeps its values', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const gate = new Latch();
    class Gated extends EchoWorker {
      override async run(text: string): Promise<string> {
        await gate.wait();
        return super.run(text);
      }
    }
    const created: EchoWorker[] = [];
    await using workers = lending(store, {
      size: new Fixed(1),
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new Gated();
        worker.release();
        created.push(worker);
        return worker;
      },
    });
    await using pool = new Pool({ kind: echo(), store, clock: globalThis });
    await workers.ready();
    const job = pool.run('late');
    try {
      await waitFor(
        () =>
          assert.deepEqual(workers.stats, {
            starting: 0,
            idle: 0,
            lent: 1,
            waiting: 0,
          }),
        { signal: t.signal, interval: 10 },
      );
      const before = workers.stats;

      created[0]!.kill();
      await waitFor(
        () =>
          assert.deepEqual(workers.stats, {
            starting: 0,
            idle: 0,
            lent: 0,
            waiting: 0,
          }),
        { signal: t.signal, interval: 10 },
      );
      assert.deepEqual(before, { starting: 0, idle: 0, lent: 1, waiting: 0 });
      gate.open();
      await assert.rejects(job, /Echo worker exited/);
    } finally {
      gate.open();
      await Promise.allSettled([job]);
    }
  });

  test('stats leave out an idle worker that exits from an on-demand owner', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const created: EchoWorker[] = [];
    await using workers = lending(store, {
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
    await using pool = new Pool({ kind: echo(), store, clock: globalThis });
    assert.equal(await pool.run('one'), 'one');
    assert.deepEqual(workers.stats, {
      starting: 0,
      idle: 1,
      lent: 0,
      waiting: 0,
    });

    created[0]!.kill();
    await waitFor(
      () =>
        assert.deepEqual(workers.stats, {
          starting: 0,
          idle: 0,
          lent: 0,
          waiting: 0,
        }),
      { signal: t.signal, interval: 10 },
    );
  });

  test('a disposal that runs again or at the same time waits for the same end, and does not fail', async () => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const created: EchoWorker[] = [];
    const workers = lending(join(folder.path, 'store.sqlite'), {
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
    await workers.ready();

    await Promise.all([
      workers[Symbol.asyncDispose](),
      workers[Symbol.asyncDispose](),
    ]);
    await workers[Symbol.asyncDispose]();

    assert.ok(created.every((worker) => worker.dead));
  });

  test('a standby starts no worker, counts nothing in its stats, and is ready only once it owns', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const options = (created: EchoWorker[]) => ({
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
    await using owner = lending(store, options([]));
    await owner.ready();
    const standbyWorkers: EchoWorker[] = [];
    await using standby = lending(store, options(standbyWorkers));
    let owns = false;
    const ready = standby.ready().then(() => (owns = true));

    // The standby campaigns while the owner keeps its term.
    await setTimeout(500);
    assert.equal(owns, false);
    assert.equal(standbyWorkers.length, 0);
    assert.deepEqual(standby.stats, {
      starting: 0,
      idle: 0,
      lent: 0,
      waiting: 0,
    });

    await owner[Symbol.asyncDispose]();
    await untilAborted(ready, t.signal);
    assert.equal(standbyWorkers.length, 1);
    assert.deepEqual(standby.stats, {
      starting: 0,
      idle: 1,
      lent: 0,
      waiting: 0,
    });
  });

  test('an owner that hands over counts nothing in its stats while its workers still end', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const ending = new Latch();
    // Ends only when the test lets it, as a helper that cleans up after its
    // signal.
    class SlowToEnd extends EchoWorker {
      override kill(): void {
        void ending.wait().then(() => super.kill());
      }

      override async close(): Promise<void> {
        await ending.wait();
        await super.close();
      }
    }
    const options = (create: () => EchoWorker) => ({
      size: new Fixed(1),
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = create();
        worker.release();
        return worker;
      },
    });
    await using owner = lending(
      store,
      options(() => new SlowToEnd()),
    );
    await owner.ready();
    await using standby = lending(
      store,
      options(() => new EchoWorker()),
    );

    const handOver = owner[Symbol.asyncDispose]();
    try {
      await untilAborted(standby.ready(), t.signal);
      assert.deepEqual(owner.stats, {
        starting: 0,
        idle: 0,
        lent: 0,
        waiting: 0,
      });
    } finally {
      ending.open();
      await handOver;
    }
  });

  test('ready() rejects with the error of a worker that the startup starts and whose warm-up fails', async () => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const created: EchoWorker[] = [];
    await using workers = lending(join(folder.path, 'store.sqlite'), {
      size: new Fixed(1),
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

    await assert.rejects(workers.ready(), /Echo worker exited/);
  });

  test('a host that stops offering its workers before it owns rejects its ready()', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const options = {
      size: new Fixed(1),
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new EchoWorker();
        worker.release();
        return worker;
      },
    };
    await using owner = lending(store, options);
    await owner.ready();
    const standby = lending(store, options);
    const ready = standby.ready();

    await standby[Symbol.asyncDispose]();

    await assert.rejects(untilAborted(ready, t.signal), { name: 'AbortError' });
  });

  test('disposing an owner while its startup runs rejects its ready(), stops every worker and starts no other', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const created: EchoWorker[] = [];
    const workers = lending(join(folder.path, 'store.sqlite'), {
      size: new Fixed(2),
      startup: new OrderedReady(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new EchoWorker();
        created.push(worker);
        return worker;
      },
    });
    await waitFor(() => assert.equal(created.length, 1), {
      signal: t.signal,
      interval: 10,
    });
    const ready = assert.rejects(workers.ready());

    await workers[Symbol.asyncDispose]();

    await ready;
    assert.equal(created.length, 1, 'the second worker must never start');
    assert.ok(created.every((worker) => worker.dead));
  });
});

// Real worker processes on a fake clock: each job waits on the clock, so a
// window of two seconds takes no real time, and the time of each job is
// exact. Each sizing reads a plain computer, not the process, so the tests
// run at the same time.
describe(
  'PoolWorkers sizes its workers on a fake clock',
  { concurrency: true },
  () => {
    test('a hill-climbing owner grows past its first two workers while a backlog of slow jobs waits', async (t) => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const clock = createClock(Date.now());
      let ended = 0;
      const created: EchoWorker[] = [];
      await using workers = lendingOn(clock, store, {
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
          // Each job takes 20 ms on the clock, so every worker added adds as
          // much.
          const worker = new Working(async () => {
            await delay(20, { clock, signal: undefined });
            ended++;
          });
          worker.release();
          created.push(worker);
          return worker;
        },
      });
      await using pool = new Pool({ kind: echo(), store, clock });
      await workers.ready();
      assert.equal(created.length, 2);

      await Array.fromAsync({ length: 1500 }, () => pool.start('job'));
      await drive(clock, [workers], () => ended === 1500, 60_000);
      assert.ok(
        created.length > 2,
        `the owner started ${created.length} workers`,
      );
      // The step that tried a third worker kept it: a worker that a step tries
      // and closes would also count above.
      await untilExited(t, workers, created);
      assert.equal(
        created[2]!.dead,
        false,
        'the owner closed the third worker, which paid',
      );
    });
  },
);

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
// The tests run one after another: each drives its clock 10 ms at a time,
// all of it work on the one thread of the test file, so tests that run at
// the same time each take as long as all of them. On CI's 4 vCPUs they took
// 145 to 300 s each, and the longest passed the 300 s limit (#5027).
void describe(
  'an owner whose sizing keeps learning',
  { concurrency: false },
  () => {
    void test.each(
      [
        { Learning: HillClimbing, units: 3, own: 0 },
        { Learning: Gradient, units: 2, own: 10 },
      ],
      ({ Learning, units, own }) =>
        test(`a ${Learning.name} owner that settled grows again when the work changes so that one more worker pays`, async (t) => {
          const clock = createClock(Date.now());
          await using folder = await new TemporaryFiles().directory('pool-');
          const store = join(folder.path, 'store.sqlite');
          await using pool = new Pool({ kind: echo(), store, clock });
          const engine = new PQueue({ concurrency: units });
          const created: EchoWorker[] = [];
          const load = closedLoad(pool, 16);
          const job = async () => {
            await delay(own, { clock, signal: undefined });
            await engine.add(() => delay(50, { clock, signal: undefined }));
          };
          await using owner = lendingOn(clock, store, {
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
              const worker = new Working(load.work(job));
              worker.release();
              created.push(worker);
              return worker;
            },
          });
          await owner.ready();
          await load.start();
          try {
            // The pool closes the worker of a step that did not pay: it settled.
            await untilDropped(t, clock, owner, created, 60_000);
            const known = created.length;

            // Four units: a fourth worker pays for both sizings.
            engine.concurrency = 4;

            // A step with one more worker starts it. The pool keeps the
            // worker when it pays, and closes it after the step when it does
            // not.
            await drive(clock, [owner], () => created.length > known, 60_000);
            const added = created[known]!;
            await driveFor(clock, [owner], 15_000);
            await untilExited(t, owner, created);
            assert.equal(
              added.dead,
              false,
              'the pool kept the worker that paid',
            );
          } finally {
            load.stop();
            await drive(clock, [owner], load.drained, 60_000);
          }
        }),
    );

    void test.each(
      [
        { Learning: HillClimbing, units: 3, own: 0 },
        { Learning: Gradient, units: 2, own: 10 },
      ],
      ({ Learning, units, own }) =>
        test(`a ${Learning.name} owner shrinks only after fewer workers did as well in two steps in a row`, async (t) => {
          const clock = createClock(Date.now());
          await using folder = await new TemporaryFiles().directory('pool-');
          const store = join(folder.path, 'store.sqlite');
          await using pool = new Pool({ kind: echo(), store, clock });
          const engine = new PQueue({ concurrency: units });
          let thrashing = false;
          const created: EchoWorker[] = [];
          const load = closedLoad(pool, 16);
          const job = async () => {
            await delay(own, { clock, signal: undefined });
            await engine.add(() =>
              delay(thrashing ? 30 * engine.pending ** 2 : 50, {
                clock,
                signal: undefined,
              }),
            );
          };
          await using owner = lendingOn(clock, store, {
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
              const worker = new Working(load.work(job));
              worker.release();
              created.push(worker);
              return worker;
            },
          });
          await owner.ready();
          await load.start();
          const timeline: { at: number; lent: number; idle: number }[] = [];
          const sampler = clock.setInterval(() => {
            const { lent, idle } = owner.stats;
            timeline.push({ at: clock.now, lent, idle });
          }, 20);
          try {
            // The pool closes the worker of a step that did not pay: it settled.
            await untilDropped(t, clock, owner, created, 60_000);
            const settled = created.filter((worker) => !worker.dead);

            // The engine thrashes: a job takes longer the more jobs share it,
            // so fewer workers do as well for both sizings.
            thrashing = true;
            engine.concurrency = Infinity;

            await untilDropped(t, clock, owner, settled, 120_000);
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

            await drive(clock, [owner], () => created.length > known, 90_000);
            const added = created[known]!;
            await driveFor(clock, [owner], 15_000);
            await untilExited(t, owner, created);
            assert.equal(
              added.dead,
              false,
              'the pool kept the worker that paid',
            );
          } finally {
            clock.clearInterval(sampler);
            load.stop();
            await drive(clock, [owner], load.drained, 60_000);
          }
        }),
    );

    void test.each(
      [
        { Learning: HillClimbing, units: 3, own: 0 },
        { Learning: Gradient, units: 2, own: 10 },
      ],
      ({ Learning, units, own }) =>
        test(`a ${Learning.name} owner under steady work starts a worker to try less and less often`, async (t) => {
          const clock = createClock(Date.now());
          await using folder = await new TemporaryFiles().directory('pool-');
          const store = join(folder.path, 'store.sqlite');
          await using pool = new Pool({ kind: echo(), store, clock });
          const engine = new PQueue({ concurrency: units });
          const created: EchoWorker[] = [];
          const born = new Map<EchoWorker, number>();
          const died = new Map<EchoWorker, number>();
          const load = closedLoad(pool, 16);
          const job = async () => {
            await delay(own, { clock, signal: undefined });
            await engine.add(() => delay(50, { clock, signal: undefined }));
          };
          await using owner = lendingOn(clock, store, {
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
              const worker = new Working(load.work(job));
              worker.release();
              created.push(worker);
              born.set(worker, clock.now);
              void worker.exited().then(() => died.set(worker, clock.now));
              return worker;
            },
          });
          await owner.ready();
          await load.start();
          try {
            // The pool closes the worker of a step that did not pay: it settled.
            await untilDropped(t, clock, owner, created, 60_000);
            const settled = created.filter((worker) => !worker.dead);
            const known = created.length;

            // Each worker that a step tries warms up for nothing: a step back
            // to back would start one about every 12 seconds.
            await driveFor(clock, [owner], 60_000);

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
              [owner],
              () => owner.stats.lent === settled.length,
              60_000,
            );
          } finally {
            load.stop();
            await drive(clock, [owner], load.drained, 60_000);
          }
        }),
    );

    test('a hill-climbing owner keeps one more worker that pays in a later step, also while the work gets slower across that step', async (t) => {
      const clock = createClock(Date.now());
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      await using pool = new Pool({ kind: echo(), store, clock });
      // Eight units: each worker up to four adds a third of the jobs of three.
      const engine = new PQueue({ concurrency: 8 });
      const created: EchoWorker[] = [];
      const load = closedLoad(pool, 16);
      // A job takes a third longer each two seconds of the clock since the
      // test began, as photos follow stickers (ADR 0002): a step that tries
      // four workers measures the jobs of three faster before it and slower
      // after it.
      const began = clock.now;
      const job = () =>
        engine.add(() =>
          delay(50 * (4 / 3) ** ((clock.now - began) / 2_000), {
            clock,
            signal: undefined,
          }),
        );
      await using owner = lendingOn(clock, store, {
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
          const worker = new Working(load.work(job));
          worker.release();
          created.push(worker);
          return worker;
        },
      });
      await owner.ready();
      await load.start();
      try {
        // The first step keeps a third worker, and the next step at once
        // tries a fourth.
        await drive(clock, [owner], () => created.length >= 4, 60_000);
        const fourth = created[3]!;

        // The step measures three again after it tried four, and decides.
        await driveFor(clock, [owner], 8_000);
        await untilExited(t, owner, created);

        assert.equal(
          fourth.dead,
          false,
          'the pool closed a fourth worker that paid',
        );
      } finally {
        load.stop();
        await drive(clock, [owner], load.drained, 120_000);
      }
    });

    test('a hill-climbing owner under steady work stops doubling the pause between two steps at sixteen windows', async () => {
      const clock = createClock(Date.now());
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      await using pool = new Pool({ kind: echo(), store, clock });
      // Two units: a third worker adds no jobs, and one worker fewer does
      // worse, so no step changes the size.
      const engine = new PQueue({ concurrency: 2 });
      const tried: number[] = [];
      const load = closedLoad(pool, 16);
      const job = () =>
        engine.add(() => delay(50, { clock, signal: undefined }));
      await using owner = lendingOn(clock, store, {
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
          const worker = new Working(load.work(job));
          worker.release();
          tried.push(clock.now);
          return worker;
        },
      });
      await owner.ready();
      await load.start();
      try {
        // The first two workers, then a worker for each step with one more.
        // The pause after the n-th step that changes nothing is 2^(n-1)
        // windows of two seconds, at most 16, times 0.5 to 1.5. A step with
        // one more and a step with fewer alternate, so two pauses and two
        // steps of three windows lie between two workers tried.
        await drive(clock, [owner], () => tried.length >= 2 + 9, 1_200_000);

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
        load.stop();
        await drive(clock, [owner], load.drained, 120_000);
      }
    });

    void test.each(
      [
        { Learning: HillClimbing, units: 3, own: 0 },
        { Learning: Gradient, units: 2, own: 10 },
      ],
      ({ Learning, units, own }) =>
        test(`a ${Learning.name} owner takes no step while no job waits`, async (t) => {
          const clock = createClock(Date.now());
          await using folder = await new TemporaryFiles().directory('pool-');
          const store = join(folder.path, 'store.sqlite');
          await using pool = new Pool({ kind: echo(), store, clock });
          const engine = new PQueue({ concurrency: units });
          const created: EchoWorker[] = [];
          const busy = closedLoad(pool, 16);
          const work = busy.work(async () => {
            await delay(own, { clock, signal: undefined });
            await engine.add(() => delay(50, { clock, signal: undefined }));
          });
          // One job at a time: no job waits, so no window says how many pay.
          // It starts once the busy load ran all of its jobs, so each run
          // after that is one of its jobs.
          const trickle = closedLoad(pool, 1);
          const trickling = trickle.work(() =>
            delay(50, { clock, signal: undefined }),
          );
          let quiet = false;
          await using owner = lendingOn(clock, store, {
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
              const worker = new Working(() => (quiet ? trickling() : work()));
              worker.release();
              created.push(worker);
              return worker;
            },
          });
          await owner.ready();
          await busy.start();
          try {
            // The pool closes the worker of a step that did not pay: it settled.
            await untilDropped(t, clock, owner, created, 60_000);
            busy.stop();
            await drive(clock, [owner], busy.drained, 60_000);
            const settled = created.filter((worker) => !worker.dead);
            const known = created.length;

            quiet = true;
            await trickle.start();
            await driveFor(clock, [owner], 30_000);
            trickle.stop();
            await drive(clock, [owner], trickle.drained, 60_000);

            assert.equal(created.length, known, 'no step started a worker');
            assert.ok(
              settled.every((worker) => !worker.dead),
              'no step closed a worker',
            );
          } finally {
            busy.stop();
            trickle.stop();
            await drive(
              clock,
              [owner],
              () => busy.drained() && trickle.drained(),
              60_000,
            );
          }
        }),
    );

    void test.each(
      [
        { Learning: HillClimbing, units: 3, own: 0 },
        { Learning: Gradient, units: 2, own: 10 },
      ],
      ({ Learning, units, own }) =>
        test(`a ${Learning.name} owner runs fewer workers when the memory they need is no longer free`, async (t) => {
          const clock = createClock(Date.now());
          await using folder = await new TemporaryFiles().directory('pool-');
          const store = join(folder.path, 'store.sqlite');
          await using pool = new Pool({ kind: echo(), store, clock });
          const engine = new PQueue({ concurrency: units });
          const created: EchoWorker[] = [];
          // Free memory for eight workers, until other processes take it.
          const memoryPerWorker = 2 ** 30;
          let free = 8 * memoryPerWorker;
          const computer = {
            availableParallelism: () => 4,
            availableMemory: () => free,
          };
          const load = closedLoad(pool, 16);
          const job = async () => {
            await delay(own, { clock, signal: undefined });
            await engine.add(() => delay(50, { clock, signal: undefined }));
          };
          await using owner = lendingOn(clock, store, {
            size: new Learning({ memoryPerWorker, computer }),
            startup: new Parallel(),
            eviction: new NoEviction(),
            create: () => {
              const worker = new Working(load.work(job));
              worker.release();
              created.push(worker);
              return worker;
            },
          });
          await owner.ready();
          await load.start();
          try {
            // The pool closes the worker of a step that did not pay: it settled.
            await untilDropped(t, clock, owner, created, 60_000);
            const settled = created.filter((worker) => !worker.dead);
            assert.ok(
              settled.length > 2,
              `the pool settled at ${settled.length}`,
            );

            // Other processes take the memory: two workers still find theirs free.
            free = 2.5 * memoryPerWorker;

            await drive(
              clock,
              [owner],
              () =>
                settled.filter((worker) => !worker.dead).length === 2 &&
                owner.stats.lent <= 2,
              60_000,
            );
          } finally {
            load.stop();
            await drive(clock, [owner], load.drained, 60_000);
          }
        }),
    );

    void test.each([HillClimbing, Gradient], (Learning) =>
      test(`a ${Learning.name} owner never runs more workers than the computer affords, also when more would pay`, async (t) => {
        const clock = createClock(Date.now());
        await using folder = await new TemporaryFiles().directory('pool-');
        const store = join(folder.path, 'store.sqlite');
        await using pool = new Pool({ kind: echo(), store, clock });
        // Eight units: every worker up to eight adds as much as the one before.
        const engine = new PQueue({ concurrency: 8 });
        const created: EchoWorker[] = [];
        // Free memory for three and a half workers.
        const memoryPerWorker = 2 ** 30;
        const computer = {
          availableParallelism: () => 4,
          availableMemory: () => 3.5 * memoryPerWorker,
        };
        const load = closedLoad(pool, 16);
        const job = () =>
          engine.add(() => delay(50, { clock, signal: undefined }));
        await using owner = lendingOn(clock, store, {
          size: new Learning({ memoryPerWorker, computer }),
          startup: new Parallel(),
          eviction: new NoEviction(),
          create: () => {
            const worker = new Working(load.work(job));
            worker.release();
            created.push(worker);
            return worker;
          },
        });
        await owner.ready();
        await load.start();
        let most = 0;
        const sampler = clock.setInterval(() => {
          most = Math.max(
            most,
            created.filter((worker) => !worker.dead).length,
          );
        }, 20);
        try {
          await drive(clock, [owner], () => owner.stats.lent === 3, 60_000);

          // Steps keep trying sizes while the work runs.
          await driveFor(clock, [owner], 40_000);

          assert.equal(most, 3);
        } finally {
          clock.clearInterval(sampler);
          load.stop();
          await drive(clock, [owner], load.drained, 60_000);
        }
      }),
    );

    test('a Gradient owner measures the time of a job with two workers again, so it shrinks when the work gets heavier for every size', async (t) => {
      // Four units and 10 ms of the job's own: a job takes 60 ms with up to four
      // workers, so the pool grows to the four that the memory affords.
      const clock = createClock(Date.now());
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      await using pool = new Pool({ kind: echo(), store, clock });
      const engine = new PQueue({ concurrency: 4 });
      const created: EchoWorker[] = [];
      const memoryPerWorker = 2 ** 30;
      const computer = {
        availableParallelism: () => 4,
        availableMemory: () => 4.5 * memoryPerWorker,
      };
      const load = closedLoad(pool, 16);
      const job = async () => {
        await delay(10, { clock, signal: undefined });
        await engine.add(() => delay(50, { clock, signal: undefined }));
      };
      await using owner = lendingOn(clock, store, {
        size: new Gradient({ memoryPerWorker, computer }),
        startup: new Parallel(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new Working(load.work(job));
          worker.release();
          created.push(worker);
          return worker;
        },
      });
      await owner.ready();
      await load.start();
      try {
        await drive(clock, [owner], () => owner.stats.lent === 4, 60_000);
        const settled = created.filter((worker) => !worker.dead);

        // Two units: a job takes 75 ms with three workers and 100 ms with four,
        // 1.67 times its 60 ms with two. Only a window at two workers shows it,
        // because the time with two that the pool measured before is stale.
        engine.concurrency = 2;

        await untilDropped(t, clock, owner, settled, 120_000);
      } finally {
        load.stop();
        await drive(clock, [owner], load.drained, 60_000);
      }
    });
  },
);

// Six owners on one clock, as six processes read one time, so they run alone.
describe('PoolWorkers of six owners on one clock', () => {
  void test.each(
    [
      { Learning: HillClimbing, units: 3, own: 0 },
      { Learning: Gradient, units: 2, own: 10 },
    ],
    ({ Learning, units, own }) =>
      test(`${Learning.name} owners under the same work do not try one more worker at the same moments`, async () => {
        const clock = createClock(Date.now());
        // Each owner has its own store and its own engine.
        await using stack = new AsyncDisposableStack();
        const runs = await Array.fromAsync({ length: 6 }, async () => {
          const folder = stack.use(
            await new TemporaryFiles().directory('pool-'),
          );
          const store = join(folder.path, 'store.sqlite');
          const pool = stack.use(new Pool({ kind: echo(), store, clock }));
          const engine = new PQueue({ concurrency: units });
          const created: { worker: EchoWorker; at: number }[] = [];
          const load = closedLoad(pool, 16);
          const job = async () => {
            await delay(own, { clock, signal: undefined });
            await engine.add(() => delay(50, { clock, signal: undefined }));
          };
          const owner = stack.use(
            lendingOn(clock, store, {
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
                const worker = new Working(load.work(job));
                worker.release();
                created.push({ worker, at: clock.now });
                return worker;
              },
            }),
          );
          return { created, load, owner };
        });
        const all = runs.map(({ owner }) => owner);
        await Promise.all(all.map((owner) => owner.ready()));
        for (const { load } of runs) await load.start();
        try {
          // Each owner lets the worker of a step that did not pay go: it
          // settled, and holds one worker fewer at once, before that worker
          // exits. Then it tries one more worker.
          const settled = new Map<number, { at: number; known: number }>();
          const last = all.map((owner) => holds(owner));
          await drive(
            clock,
            all,
            () => {
              for (const [index, { created, owner }] of runs.entries()) {
                const now = holds(owner);
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

          // Owners that probe in step measure each other's probes, as .NET
          // randomizes its hill climbing for other processes that run it. On
          // one clock, owners with no jitter try one more worker the same
          // time after they settle, to the 10 ms that the clock moves at once.
          const spread = Math.max(...delays) - Math.min(...delays);
          assert.ok(
            spread >= 100,
            `the owners tried one more worker ${delays.join(', ')} ms after they settled`,
          );
        } finally {
          for (const { load } of runs) load.stop();
          await drive(
            clock,
            all,
            () => runs.every(({ load }) => load.drained()),
            60_000,
          );
        }
      }),
  );
});

// The owner on a fake clock replaces the workers that exit, and backs off
// after an early exit or a failed warm-up. A minute cannot pass in a test:
// the test moves the timers instead. The clock also runs the owner's
// backstop, the passes of the owner's and the Pool's stores, a result's
// backstop and the election, so the tests count the timers of a back-off
// against a quiet moment in which no result waits.
describe('PoolWorkers backs off on a fake clock', { concurrency: true }, () => {
  test('an eager owner waits before it replaces a worker that exits early: 1 s, doubled for each early exit in a row, up to 60 s', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    await using owner = lendingOn(clock, store, {
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
    await using pool = new Pool({ kind: echo(), store, clock });
    await owner.ready();

    for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000]) {
      const worker = created.at(-1)!;
      worker.kill();
      await worker.exited();
      await clock.tickAsync(wait - 1);
      assert.deepEqual(
        owner.stats,
        { starting: 0, idle: 0, lent: 0, waiting: 0 },
        `the owner still waits at ${wait - 1} ms`,
      );
      // The passes of the Pool's store end on the clock at the same moment,
      // and the event loop turns between them, so the worker may be warm.
      await clock.tickAsync(1);
      assert.equal(holds(owner), 1, `the owner starts at ${wait} ms`);
      assert.equal(await pool.run('up'), 'up');
    }
    assert.equal(created.length, 8);
  });

  test('an eager owner starts a worker again after its warm-up fails: 1 s, doubled for each failure in a row, up to 60 s, so a warm worker waits before any job', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    const waits = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
    await using owner = lendingOn(clock, join(folder.path, 'store.sqlite'), {
      size: new Fixed(1),
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new EchoWorker();
        if (created.length < waits.length) worker.fail();
        else worker.release();
        created.push(worker);
        return worker;
      },
    });
    await assert.rejects(owner.ready(), /Echo worker exited/);

    for (const wait of waits) {
      await created.at(-1)!.exited();
      await waitFor(() => assert.equal(owner.stats.starting, 0), {
        signal: t.signal,
        interval: 5,
      });
      const started = created.length;
      await clock.tickAsync(wait - 1);
      assert.deepEqual(
        owner.stats,
        { starting: 0, idle: 0, lent: 0, waiting: 0 },
        `the owner still waits at ${wait - 1} ms`,
      );
      // The passes of the store end on the clock at the same moment, and the
      // event loop turns between them, so the new worker may already have
      // failed its warm-up: the test counts the workers the owner created.
      await clock.tickAsync(1);
      // The worker is created a microtask after its slot starts.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        created.length,
        started + 1,
        `the owner starts at ${wait} ms`,
      );
    }

    await waitFor(() => assert.equal(owner.stats.idle, 1), {
      signal: t.signal,
      interval: 5,
    });
    assert.equal(created.length, waits.length + 1);
  });

  test('a leader-first owner whose leader fails its warm-up starts the others, then the slot of the leader again after the back-off, so every worker is warm before the first job', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    await using owner = lendingOn(clock, join(folder.path, 'store.sqlite'), {
      size: new Fixed(2),
      startup: new LeaderFirst(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new EchoWorker();
        if (created.length === 0) worker.fail();
        else worker.release();
        created.push(worker);
        return worker;
      },
    });
    await assert.rejects(owner.ready(), /Echo worker exited/);
    await waitFor(() => assert.equal(owner.stats.idle, 1), {
      signal: t.signal,
      interval: 5,
    });
    assert.equal(
      created.length,
      2,
      'the other worker starts once the leader failed',
    );

    await clock.tickAsync(1_000);
    await waitFor(() => assert.equal(owner.stats.idle, 2), {
      signal: t.signal,
      interval: 5,
    });
    await clock.tickAsync(60_000);
    assert.equal(created.length, 3, 'no worker starts twice');
    assert.deepEqual(owner.stats, {
      starting: 0,
      idle: 2,
      lent: 0,
      waiting: 0,
    });
  });

  test('a worker that a job starts in an eager owner and whose warm-up fails fails the job, and its slot backs off for the early exits in a row and starts again', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    await using owner = lendingOn(clock, store, {
      size: new Fixed(1),
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new EchoWorker();
        if (created.length === 1) worker.fail();
        else worker.release();
        created.push(worker);
        return worker;
      },
    });
    await using pool = new Pool({ kind: echo(), store, clock });
    await owner.ready();
    // The Pool listens once its store started, and the owner rests on its
    // backstop once the event loop turns.
    await pool.stats();
    await new Promise((resolve) => setImmediate(resolve));
    const quiet = clock.countTimers();
    // An early exit puts the slot in a back-off of 1 s.
    created[0]!.kill();
    await created[0]!.exited();

    // The job does not wait out the back-off: it starts a worker now, whose
    // warm-up fails. A job that waits anyway fails at the limit of the test,
    // t.signal, since the clock never moves.
    await assert.rejects(pool.run('now'), /Echo worker exited/);
    assert.equal(created.length, 2);
    // The owner fails the job in the store, then rests on its backstop again.
    await waitFor(
      () =>
        assert.equal(
          clock.countTimers(),
          quiet + 1,
          'only the back-off of 2 s waits',
        ),
      { signal: t.signal, interval: 5 },
    );

    await clock.tickAsync(1_999);
    assert.deepEqual(
      owner.stats,
      { starting: 0, idle: 0, lent: 0, waiting: 0 },
      'the second early exit in a row waits 2 s',
    );
    await clock.tickAsync(1);
    await waitFor(() => assert.equal(owner.stats.idle, 1), {
      signal: t.signal,
      interval: 5,
    });
    assert.equal(created.length, 3);
  });

  test('a job that needs a slot in back-off after a failed warm-up starts its worker at once, and the back-off starts no other', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    await using owner = lendingOn(clock, store, {
      size: new Fixed(1),
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
    await using pool = new Pool({ kind: echo(), store, clock });
    await assert.rejects(owner.ready(), /Echo worker exited/);
    // A failed warm-up puts the slot in a back-off of 1 s. The Pool listens
    // once its store started, and the owner rests on its backstop.
    await pool.stats();
    await waitFor(() => assert.equal(owner.stats.starting, 0), {
      signal: t.signal,
      interval: 5,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const quiet = clock.countTimers() - 1;

    // The timers do not move, so the job cannot wait out the back-off.
    assert.equal(await pool.run('now'), 'now');
    await waitFor(
      () =>
        assert.equal(
          clock.countTimers(),
          quiet,
          'the job ended the wait of the back-off',
        ),
      { signal: t.signal, interval: 5 },
    );
    await clock.tickAsync(60_000);
    assert.equal(created.length, 2);
    assert.deepEqual(owner.stats, {
      starting: 0,
      idle: 1,
      lent: 0,
      waiting: 0,
    });
  });

  test('disposing an owner in the back-off after a failed warm-up leaves no timer on its clock and starts no worker', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    const owner = lendingOn(clock, join(folder.path, 'store.sqlite'), {
      size: new Fixed(1),
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new EchoWorker();
        worker.fail();
        created.push(worker);
        return worker;
      },
    });
    await assert.rejects(owner.ready(), /Echo worker exited/);
    await waitFor(() => assert.equal(owner.stats.starting, 0), {
      signal: t.signal,
      interval: 5,
    });

    await owner[Symbol.asyncDispose]();
    assert.equal(clock.countTimers(), 0);
    await clock.tickAsync(60_000);
    assert.equal(created.length, 1);
  });

  test('an on-demand owner starts no worker after a failed warm-up until a job needs one, and that job starts one at once', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    await using owner = lendingOn(clock, store, {
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
    await using pool = new Pool({ kind: echo(), store, clock });
    await assert.rejects(pool.run('first'), /Echo worker exited/);

    await clock.tickAsync(60_000);
    assert.equal(created.length, 1, 'no worker starts by itself');
    assert.equal(await pool.run('second'), 'second');
    assert.equal(created.length, 2);
  });

  test('a job that needs a slot in back-off starts its worker at once, and the back-off starts no other', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    await using owner = lendingOn(clock, store, {
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
    await using pool = new Pool({ kind: echo(), store, clock });
    await owner.ready();
    created[0]!.kill();
    await created[0]!.exited();
    assert.deepEqual(owner.stats, {
      starting: 0,
      idle: 0,
      lent: 0,
      waiting: 0,
    });

    // The timers do not move, so the job cannot wait out the back-off. A job
    // that waits anyway fails at the limit of the test, t.signal.
    assert.equal(await pool.run('now'), 'now');
    await clock.tickAsync(60_000);
    assert.equal(created.length, 2);
    assert.deepEqual(owner.stats, {
      starting: 0,
      idle: 1,
      lent: 0,
      waiting: 0,
    });
  });

  test('disposing an owner in back-off leaves no timer on its clock', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    const owner = lendingOn(clock, join(folder.path, 'store.sqlite'), {
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
    await owner.ready();
    const before = clock.countTimers();
    created[0]!.kill();
    await created[0]!.exited();
    await waitFor(
      () =>
        assert.equal(
          clock.countTimers(),
          before + 1,
          'the back-off waits on a timer',
        ),
      { signal: t.signal, interval: 5 },
    );

    await owner[Symbol.asyncDispose]();
    assert.equal(clock.countTimers(), 0);
  });

  test('a worker that ran 10 minutes is replaced at once, and ends the back-off', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    await using owner = lendingOn(clock, store, {
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
    await using pool = new Pool({ kind: echo(), store, clock });
    await owner.ready();
    created[0]!.kill();
    await created[0]!.exited();
    await clock.tickAsync(1_000);
    assert.equal(await pool.run('up'), 'up');

    // The worker runs ten minutes on the clock.
    await clock.tickAsync(600_000);
    created[1]!.kill();
    await created[1]!.exited();
    assert.equal(owner.stats.starting, 1);
  });

  test('a slot that the sizing stops keeping during its back-off starts no stray worker once the sizing runs it again', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    const sizing = new Steered();
    await using owner = lendingOn(clock, store, {
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
    await using pool = new Pool({ kind: echo(), store, clock });
    await owner.ready();
    const run = (text: string) => pool.run(text);
    created[1]!.kill();
    await created[1]!.exited();
    // Slot 1 backs off: its worker is gone and no new one starts yet.
    assert.deepEqual(owner.stats, {
      starting: 0,
      idle: 1,
      lent: 0,
      waiting: 0,
    });

    sizing.current = 1;
    sizing.kept = 1;
    assert.equal(await run('a'), 'a');
    sizing.current = 2;
    sizing.kept = 2;
    assert.equal(await run('b'), 'b');
    assert.deepEqual(await Promise.all([run('c'), run('d')]), ['c', 'd']);
    assert.equal(created.length, 3);

    await clock.tickAsync(60_000);
    assert.deepEqual(owner.stats, {
      starting: 0,
      idle: 2,
      lent: 0,
      waiting: 0,
    });
    // A stray worker would be created a microtask after its slot starts.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(created.length, 3);
  });
});

// The owner on a fake clock closes an idle worker that its eviction lets go.
// A Pool on the same clock sends the jobs, and the owner hears of each at
// once, so a job runs while the clock stands still.
describe('PoolWorkers evicts on a fake clock', { concurrency: true }, () => {
  test('an idle worker closes once its idle timeout passes, and not 1 ms sooner, and the stats then count it nowhere', async () => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    // The idle wait starts when the worker becomes ready, so the timers move
    // from before that.
    await using owner = lendingOn(clock, join(folder.path, 'store.sqlite'), {
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
    await owner.ready();

    await clock.tickAsync(999);
    assert.deepEqual(owner.stats, {
      starting: 0,
      idle: 1,
      lent: 0,
      waiting: 0,
    });
    assert.equal(created[0]!.dead, false);

    await clock.tickAsync(1);
    assert.deepEqual(owner.stats, {
      starting: 0,
      idle: 0,
      lent: 0,
      waiting: 0,
    });
    await created[0]!.exited();
    assert.equal(created.length, 1);
  });

  test('a job that takes an idle worker before its idle timeout passes keeps it, and its end starts a new idle timeout', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    const ends: number[] = [];
    await using owner = lendingOn(clock, store, {
      size: new Fixed(1),
      startup: new Parallel(),
      eviction: new IdleTimeout({ after: 1_000 }),
      create: () => {
        const worker = new Held(() => Promise.resolve(), clock, ends);
        worker.release();
        created.push(worker);
        return worker;
      },
    });
    await using pool = new Pool({ kind: echo(), store, clock });
    await owner.ready();
    const first = clock.now + 1_000;
    // The Pool listens once its store started, and the owner rests on its
    // backstop once the event loop turns.
    await pool.stats();
    await new Promise((resolve) => setImmediate(resolve));
    const quiet = clock.countTimers();

    await clock.tickAsync(999);
    assert.equal(await pool.run('busy'), 'busy');
    // The worker idles again before the first idle timeout would end. As many
    // timers wait as before the job: the job stopped the first idle timeout,
    // and its end started one in its place.
    await waitFor(
      () =>
        assert.equal(
          clock.countTimers(),
          quiet,
          'the job must stop the idle timeout',
        ),
      { signal: t.signal, interval: 5 },
    );
    // The job stopped the first idle timeout: at its end the worker stays.
    await clock.tickAsync(first - clock.now);
    assert.deepEqual(
      owner.stats,
      { starting: 0, idle: 1, lent: 0, waiting: 0 },
      'the first idle timeout evicted the worker',
    );

    // The end of the job started a new idle timeout of 1 s.
    await clock.tickAsync(ends[0]! + 999 - clock.now);
    assert.deepEqual(owner.stats, {
      starting: 0,
      idle: 1,
      lent: 0,
      waiting: 0,
    });
    assert.equal(created[0]!.dead, false);
    await clock.tickAsync(1);
    assert.deepEqual(owner.stats, {
      starting: 0,
      idle: 0,
      lent: 0,
      waiting: 0,
    });
    await created[0]!.exited();
    assert.equal(created.length, 1);
  });

  test('an owner does not evict a worker while a job holds it past its idle timeout, and the end of the job starts a new idle timeout', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    const gate = new Latch();
    const ends: number[] = [];
    await using owner = lendingOn(clock, store, {
      size: new Fixed(1),
      startup: new Parallel(),
      eviction: new IdleTimeout({ after: 1_000 }),
      create: () => {
        const worker = new Held(() => gate.wait(), clock, ends);
        worker.release();
        created.push(worker);
        return worker;
      },
    });
    await using pool = new Pool({ kind: echo(), store, clock });
    await owner.ready();
    const deadline = clock.now + 1_000;
    const held = await pool.start('held');
    try {
      await waitFor(() => assert.equal(owner.stats.lent, 1), {
        signal: t.signal,
        interval: 5,
      });
      await clock.tickAsync(deadline + 1 - clock.now);
      assert.equal(created[0]!.dead, false, 'the lent worker was evicted');
      assert.deepEqual(owner.stats, {
        starting: 0,
        idle: 0,
        lent: 1,
        waiting: 0,
      });
    } finally {
      gate.open();
      assert.equal(await held.result(), 'held');
    }

    await clock.tickAsync(ends[0]! + 999 - clock.now);
    assert.deepEqual(owner.stats, {
      starting: 0,
      idle: 1,
      lent: 0,
      waiting: 0,
    });
    await clock.tickAsync(1);
    assert.deepEqual(owner.stats, {
      starting: 0,
      idle: 0,
      lent: 0,
      waiting: 0,
    });
    await created[0]!.exited();
  });

  test('an evicted worker starts no replacement and no back-off, and a job then starts a worker at once, also after a leader-first start', async (t) => {
    for (const startup of [new Parallel(), new LeaderFirst()]) {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const clock = createClock(Date.now());
      const created: EchoWorker[] = [];
      await using owner = lendingOn(clock, store, {
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
      await using pool = new Pool({ kind: echo(), store, clock });
      await owner.ready();

      await clock.tickAsync(1_000);
      await Promise.all(created.map((worker) => worker.exited()));
      await clock.tickAsync(60_000);
      assert.equal(created.length, 2, `${startup.constructor.name} replaced`);
      assert.deepEqual(owner.stats, {
        starting: 0,
        idle: 0,
        lent: 0,
        waiting: 0,
      });

      // The timers do not move, so a job that waits for a back-off fails at
      // the limit of the test, t.signal.
      assert.equal(await pool.run('now'), 'now');
      assert.equal(created.length, 3);
    }
  });

  test('disposing an owner leaves no idle timeout on its clock', async () => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const clock = createClock(Date.now());
    const owner = lendingOn(clock, join(folder.path, 'store.sqlite'), {
      size: new Fixed(1),
      startup: new Parallel(),
      eviction: new IdleTimeout({ after: 60_000 }),
      create: () => {
        const worker = new EchoWorker();
        worker.release();
        return worker;
      },
    });
    await owner.ready();

    await owner[Symbol.asyncDispose]();
    assert.equal(clock.countTimers(), 0);
  });

  test('an owner with no eviction keeps its idle workers', async () => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    await using owner = lendingOn(clock, join(folder.path, 'store.sqlite'), {
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
    await owner.ready();

    await clock.tickAsync(3_600_000);
    assert.deepEqual(owner.stats, {
      starting: 0,
      idle: 2,
      lent: 0,
      waiting: 0,
    });
    assert.ok(created.every((worker) => !worker.dead));
  });

  test('an owner does not evict a worker that the sizing keeps but does not run, and evicts it once the sizing runs it again', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    const sizing = new Steered();
    // Only the job "held" waits at the gate.
    const gate = new Latch();
    const ends: number[] = [];
    await using owner = lendingOn(clock, store, {
      size: sizing,
      startup: new Parallel(),
      eviction: new IdleTimeout({ after: 1_000 }),
      create: () => {
        const worker = new Held(
          (text) => (text === 'held' ? gate.wait() : Promise.resolve()),
          clock,
          ends,
        );
        worker.release();
        created.push(worker);
        return worker;
      },
    });
    await using pool = new Pool({ kind: echo(), store, clock });
    await owner.ready();
    const run = (text: string) => pool.run(text);

    sizing.current = 1;
    assert.equal(await run('a'), 'a');
    // A job holds the worker the owner runs, so only the kept one is idle.
    const held = await pool.start('held');
    try {
      await waitFor(() => assert.equal(owner.stats.lent, 1), {
        signal: t.signal,
        interval: 5,
      });
      await clock.tickAsync(5_000);
      assert.equal(created[1]!.dead, false, 'the kept worker was evicted');
    } finally {
      gate.open();
      assert.equal(await held.result(), 'held');
    }

    sizing.current = 2;
    assert.equal(await run('b'), 'b');
    await clock.tickAsync(ends.at(-1)! + 999 - clock.now);
    assert.deepEqual(owner.stats, {
      starting: 0,
      idle: 2,
      lent: 0,
      waiting: 0,
    });
    await clock.tickAsync(1);
    assert.deepEqual(owner.stats, {
      starting: 0,
      idle: 0,
      lent: 0,
      waiting: 0,
    });
    await Promise.all(created.map((worker) => worker.exited()));
    assert.equal(created.length, 2);
  });

  test('the owner aborts the signal of an idle wait when a job takes the worker, starts a new wait when the job ends, and aborts it at the disposal', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const signals: AbortSignal[] = [];
    // Whether the first idle wait was over when the job ran.
    const taken: boolean[] = [];
    class Watching extends EchoWorker {
      override async run(text: string): Promise<string> {
        taken.push(signals[0]!.aborted);
        return super.run(text);
      }
    }
    await using owner = lending(store, {
      size: new Fixed(1),
      startup: new Parallel(),
      eviction: {
        idle(busy: AbortSignal) {
          signals.push(busy);
        },
      },
      create: () => {
        const worker = new Watching();
        worker.release();
        return worker;
      },
    });
    await using pool = new Pool({ kind: echo(), store, clock: globalThis });
    await owner.ready();
    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.aborted, false);

    assert.equal(await pool.run('busy'), 'busy');
    assert.deepEqual(taken, [true], 'a job took the worker');
    assert.equal(signals.length, 2);
    assert.equal(signals[1]!.aborted, false);

    await owner[Symbol.asyncDispose]();
    assert.equal(signals[1]!.aborted, true);
  });

  test('a worker evicted after it ran 10 minutes ends the back-off', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    // A job of the kind runs at most 60 s, so the worker idles for 11 minutes
    // before its eviction, in place of a job that holds it for 10.
    await using owner = lendingOn(clock, store, {
      size: new Fixed(1),
      startup: new Parallel(),
      eviction: new IdleTimeout({ after: 660_000 }),
      create: () => {
        const worker = new EchoWorker();
        worker.release();
        created.push(worker);
        return worker;
      },
    });
    await using pool = new Pool({ kind: echo(), store, clock });
    await owner.ready();
    // An early exit starts the back-off.
    created[0]!.kill();
    await created[0]!.exited();
    await clock.tickAsync(1_000);
    await waitFor(() => assert.equal(owner.stats.idle, 1), {
      signal: t.signal,
      interval: 5,
    });

    await clock.tickAsync(660_000);
    await created[1]!.exited();
    assert.equal(await pool.run('again'), 'again');

    created[2]!.kill();
    await created[2]!.exited();
    await clock.tickAsync(999);
    assert.equal(owner.stats.starting, 0, 'the owner still waits at 999 ms');
    await clock.tickAsync(1);
    assert.equal(owner.stats.starting, 1, 'the owner starts at 1 s, not 2 s');
  });
});

// Which slot an owner lends to a job. A worker of these tests answers the
// line "pid" with its process id, so a test sees which worker ran the job.
describe('PoolWorkers lends in order', { concurrency: true }, () => {
  test('a job takes an idle worker before it starts or waits for one in a lower slot', async (t) => {
    await t.test(
      'an empty slot, whose worker the eviction let go',
      async (st) => {
        await using folder = await new TemporaryFiles().directory('pool-');
        const store = join(folder.path, 'store.sqlite');
        const clock = createClock(Date.now());
        const created: EchoWorker[] = [];
        const first = new Latch();
        const second = new Latch();
        const holds: Record<string, Latch> = { first, second };
        await using owner = lendingOn(clock, store, {
          size: new Fixed(2),
          startup: new Parallel(),
          eviction: new IdleTimeout({ after: 30_000 }),
          create: () => {
            const worker = new Pid(holds);
            worker.release();
            created.push(worker);
            return worker;
          },
        });
        await using pool = new Pool({ kind: echo(), store, clock });
        await owner.ready();
        // Two jobs hold both workers. The first job ends, and the eviction lets
        // its idle worker go while the second job holds the other one.
        // A job of the kind runs at most 60 s, so the idle timeout lasts 30 s.
        const jobs = await Array.fromAsync(['first', 'second'], (text) =>
          pool.start(text),
        );
        await waitFor(() => assert.equal(owner.stats.lent, 2), {
          signal: st.signal,
          interval: 5,
        });
        first.open();
        await jobs[0]!.result();
        await clock.tickAsync(30_000);
        await created[0]!.exited();
        second.open();
        await jobs[1]!.result();

        assert.equal(await pool.run('pid'), String(created[1]!.pid));
        assert.equal(created.length, 2);
      },
    );

    await t.test('a slot whose worker ended', async (st) => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const created: EchoWorker[] = [];
      await using owner = lending(store, {
        size: new Fixed(2),
        startup: new OnDemand(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new Pid({});
          worker.release();
          created.push(worker);
          return worker;
        },
      });
      await using pool = new Pool({ kind: echo(), store, clock: globalThis });
      assert.deepEqual(await Promise.all([pool.run('a'), pool.run('b')]), [
        'a',
        'b',
      ]);
      created[0]!.kill();
      await created[0]!.exited();

      assert.equal(await pool.run('pid'), String(created[1]!.pid));
      assert.equal(created.length, 2);
    });

    await t.test('a slot in a back-off', async (st) => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const clock = createClock(Date.now());
      const created: EchoWorker[] = [];
      await using owner = lendingOn(clock, store, {
        size: new Fixed(2),
        startup: new Parallel(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new Pid({});
          worker.release();
          created.push(worker);
          return worker;
        },
      });
      await using pool = new Pool({ kind: echo(), store, clock });
      await owner.ready();
      created[0]!.kill();
      await created[0]!.exited();

      assert.equal(await pool.run('pid'), String(created[1]!.pid));
      assert.equal(created.length, 2);
    });

    await t.test('a slot whose worker still warms up', async (st) => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const created: EchoWorker[] = [];
      await using owner = lending(store, {
        size: new Fixed(2),
        startup: new Parallel(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new Pid({});
          if (created.length > 0) worker.release();
          created.push(worker);
          return worker;
        },
      });
      await using pool = new Pool({ kind: echo(), store, clock: globalThis });
      try {
        await waitFor(() => assert.ok(owner.stats.idle > 0), {
          signal: st.signal,
          interval: 10,
        });

        assert.equal(await pool.run('pid'), String(created[1]!.pid));
        assert.equal(created.length, 2);
      } finally {
        created[0]!.release();
      }
    });
  });

  test('jobs one at a time stay on the lowest idle worker, so the owner evicts the higher idle workers', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    await using owner = lendingOn(clock, store, {
      size: new Fixed(3),
      startup: new Parallel(),
      eviction: new IdleTimeout({ after: 1_000 }),
      create: () => {
        const worker = new Pid({});
        worker.release();
        created.push(worker);
        return worker;
      },
    });
    await using pool = new Pool({ kind: echo(), store, clock });
    await owner.ready();

    for (let job = 0; job < 4; job++) {
      await clock.tickAsync(500);
      assert.equal(await pool.run('pid'), String(created[0]!.pid));
    }
    await Promise.all([created[1]!.exited(), created[2]!.exited()]);
    assert.deepEqual(owner.stats, {
      starting: 0,
      idle: 1,
      lent: 0,
      waiting: 0,
    });
    assert.equal(created[0]!.dead, false);
    assert.equal(created.length, 3);
  });

  test('an eager owner replaces a worker that exits during a job once the job ends, after the back-off of an early exit', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    // The job kills its own worker, as a job with its own time limit does.
    class SelfEnding extends EchoWorker {
      override async run(text: string): Promise<string> {
        this.kill();
        await this.exited();
        return text;
      }
    }
    await using owner = lendingOn(clock, store, {
      size: new Fixed(1),
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new SelfEnding();
        worker.release();
        created.push(worker);
        return worker;
      },
    });
    await using pool = new Pool({ kind: echo(), store, clock });
    await owner.ready();

    assert.equal(await pool.run('done'), 'done');
    await clock.tickAsync(999);
    assert.deepEqual(owner.stats, {
      starting: 0,
      idle: 0,
      lent: 0,
      waiting: 0,
    });
    // The passes of the Pool's store end on the clock at the same moment,
    // and the event loop turns between them, so the worker may be warm.
    await clock.tickAsync(1);
    assert.equal(holds(owner), 1, 'the owner starts at 1 s');
    // The worker is created a microtask after its slot starts.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(created.length, 2);
  });

  test('a job takes an empty slot before a slot in back-off', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const clock = createClock(Date.now());
    const created: EchoWorker[] = [];
    let started = false;
    class Starting extends EchoWorker {
      override run(text: string): Promise<string> {
        started = true;
        return super.run(text);
      }
    }
    // A job of the kind runs at most 60 s, so the eviction lets an idle worker
    // go after 30 s.
    await using owner = lendingOn(clock, store, {
      size: new Fixed(2),
      startup: new Parallel(),
      eviction: new IdleTimeout({ after: 30_000 }),
      create: () => {
        const worker = new Starting();
        worker.release();
        created.push(worker);
        return worker;
      },
    });
    await using pool = new Pool({ kind: echo(), store, clock });
    await owner.ready();
    // A job holds the first worker while the eviction lets the idle second
    // one go, which leaves its slot empty.
    const held = await pool.start('hang');
    await waitFor(() => assert.ok(started, 'the job runs'), {
      signal: t.signal,
      interval: 5,
    });
    await clock.tickAsync(30_000);
    await created[1]!.exited();
    // An early exit during the job puts the first slot in a back-off of 1 s
    // once the job ends.
    created[0]!.kill();
    await assert.rejects(held.result(), /Echo worker exited/);

    assert.equal(await pool.run('empty'), 'empty');
    assert.equal(created.length, 3);
    await clock.tickAsync(1_000);
    // The worker is created a microtask after its slot starts.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(created.length, 4, 'the back-off starts its own worker');
  });
});

// A store that fails in the background: another connection holds the write
// lock of the store's file, as another program would, so the passes of the
// store and the owner's fetches wait 5 s for it and then fail with
// SQLITE_BUSY. These tests block the event loop for those waits, so they run
// alone.
describe('PoolWorkers when its store fails', () => {
  test('a failure of the store in the background is a process warning, and the owner keeps owning', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    await using owner = lending(store, {
      size: new Fixed(1),
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new EchoWorker();
        worker.release();
        return worker;
      },
    });
    await owner.ready();
    const warnings: Error[] = [];
    const warned = Promise.withResolvers<void>();
    const onWarning = (warning: Error) => {
      if (!/database is locked/.test(warning.message)) return;
      warnings.push(warning);
      warned.resolve();
    };
    process.on('warning', onWarning);
    const holder = open(store);
    try {
      holder.exec('BEGIN IMMEDIATE');
      await untilAborted(warned.promise, t.signal);
      holder.exec('ROLLBACK');

      // Built once the lock ends, so only the owner's store meets the lock.
      await using pool = new Pool({ kind: echo(), store, clock: globalThis });
      assert.equal(await pool.run('after'), 'after');
      assert.ok(warnings.length > 0);
    } finally {
      if (holder.isTransaction) holder.exec('ROLLBACK');
      holder.close();
      process.off('warning', onWarning);
    }
  });

  test('a touch that fails is a process warning, and the job keeps its worker', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const gate = new Latch();
    let started = 0;
    class Gated extends EchoWorker {
      override async run(text: string): Promise<string> {
        started = performance.now();
        await gate.wait();
        return super.run(text);
      }
    }
    const created: EchoWorker[] = [];
    await using owner = lending(store, {
      size: new Fixed(1),
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new Gated();
        worker.release();
        created.push(worker);
        return worker;
      },
    });
    await owner.ready();
    // The sender ends before the lock, as a program that started the job and
    // exited, so only the owner's store meets the lock.
    let kept: string;
    {
      await using pool = new Pool({ kind: echo(), store, clock: globalThis });
      ({ id: kept } = await pool.start('kept'));
    }
    await waitFor(() => assert.ok(started > 0, 'the job runs'), {
      signal: t.signal,
      interval: 10,
    });
    let warnings = 0;
    const onWarning = (warning: Error) => {
      if (/database is locked/.test(warning.message)) warnings++;
    };
    process.on('warning', onWarning);
    const holder = open(store);
    try {
      holder.exec('BEGIN IMMEDIATE');
      // The first touch comes 5 s after the fetch. The lock outlasts it and
      // the wait of 5 s that the touch spends on the lock.
      await waitFor(
        () => {
          assert.ok(warnings > 0, 'the store failed');
          assert.ok(performance.now() - started > 11_000, 'a touch failed');
        },
        { signal: t.signal, interval: 50 },
      );
      holder.exec('ROLLBACK');

      // The touch spent the heartbeat's margin on the lock, so the store may
      // fail the job before its worker answers, as pg-boss does when a
      // heartbeat lapses. Either way the worker stays, and runs the next job.
      gate.open();
      await using pool = new Pool({ kind: echo(), store, clock: globalThis });
      await Promise.allSettled([pool.handle(kept).result()]);
      assert.equal(await pool.run('next'), 'next');
      assert.equal(created.length, 1, 'the owner killed the worker of the job');
    } finally {
      gate.open();
      if (holder.isTransaction) holder.exec('ROLLBACK');
      holder.close();
      process.off('warning', onWarning);
    }
  });

  test('a settle that fails is a process warning, the job lapses by its heartbeat, and the owner runs the next job', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    const gate = new Latch();
    let answered = 0;
    class Gated extends EchoWorker {
      override async run(text: string): Promise<string> {
        if (text === 'lapsed') {
          await gate.wait();
          answered = performance.now();
        }
        return super.run(text);
      }
    }
    await using owner = lending(store, {
      size: new Fixed(1),
      startup: new Parallel(),
      eviction: new NoEviction(),
      create: () => {
        const worker = new Gated();
        worker.release();
        return worker;
      },
    });
    await using pool = new Pool({ kind: echo(), store, clock: globalThis });
    await owner.ready();
    const lapsed = await pool.start('lapsed');
    await waitFor(() => assert.equal(owner.stats.lent, 1), {
      signal: t.signal,
      interval: 10,
    });
    const holder = open(store);
    try {
      holder.exec('BEGIN IMMEDIATE');
      // The worker answers while the lock holds: the owner's complete waits
      // 5 s for the lock and fails.
      gate.open();
      await waitFor(
        () =>
          assert.ok(
            answered > 0 && performance.now() - answered > 6_000,
            'the settle failed',
          ),
        { signal: t.signal, interval: 50 },
      );
      holder.exec('ROLLBACK');

      // No owner touches the job any more, so its heartbeat of 10 s lapses
      // and the store fails it, as the kind runs a job only once.
      await assert.rejects(lapsed.result(), (error) => {
        assert.ok(error instanceof JobFailedError);
        assert.deepEqual(error.failure, {
          name: 'Error',
          message: 'job heartbeat timeout',
        });
        return true;
      });
      assert.equal(await pool.run('next'), 'next');
    } finally {
      gate.open();
      if (holder.isTransaction) holder.exec('ROLLBACK');
      holder.close();
    }
  });
});

// The Pool that sends the jobs, beside the PoolWorkers that run them.
describe(
  'Pool sends jobs and waits for their outputs',
  { concurrency: true },
  () => {
    test('a run aborted while its job runs kills only its worker at the next touch, and the next job takes the idle worker', async (t) => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const created: EchoWorker[] = [];
      await using owner = lending(store, {
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
      await using pool = new Pool({ kind: echo(), store, clock: globalThis });
      await owner.ready();
      const stop = new AbortController();
      const reason = new Error('Stop this job');
      const hung = pool.run('hang', { signal: stop.signal });
      // The other job ends on the other worker while the first one runs.
      assert.equal(await pool.run('other'), 'other');
      assert.deepEqual(owner.stats, {
        starting: 0,
        idle: 1,
        lent: 1,
        waiting: 0,
      });

      stop.abort(reason);
      await assert.rejects(hung, (error) => error === reason);
      // The owner learns of the cancel at its next touch, 5 s on.
      await waitFor(
        () =>
          assert.equal(
            created.filter((worker) => worker.dead).length,
            1,
            'the owner kills the worker of the cancelled job',
          ),
        { signal: t.signal, interval: 50 },
      );
      assert.equal(created[0]!.dead, true);
      assert.equal(created[1]!.dead, false);

      assert.equal(await pool.run('next'), 'next');
      assert.equal(created.length, 2);
    });

    test('a run aborted before its turn never runs', async (t) => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const first = new Latch();
      const ran: string[] = [];
      class Recording extends EchoWorker {
        override async run(text: string): Promise<string> {
          ran.push(text);
          if (text === 'busy') await first.wait();
          return super.run(text);
        }
      }
      await using owner = lending(store, {
        size: new Fixed(1),
        startup: new Parallel(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new Recording();
          worker.release();
          return worker;
        },
      });
      await using pool = new Pool({ kind: echo(), store, clock: globalThis });
      await owner.ready();
      const busy = pool.run('busy');
      await waitFor(() => assert.deepEqual(ran, ['busy']), {
        signal: t.signal,
        interval: 10,
      });
      const stop = new AbortController();
      const queued = pool.run('queued', { signal: stop.signal });

      stop.abort();
      await assert.rejects(queued, { name: 'AbortError' });
      first.open();
      assert.equal(await busy, 'busy');
      assert.equal(await pool.run('after'), 'after');
      assert.deepEqual(ran, ['busy', 'after']);
    });

    test('a run aborted while its worker warms up leaves the warm-up running for later jobs', async (t) => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const created: EchoWorker[] = [];
      await using owner = lending(store, {
        size: new Fixed(1),
        startup: new LeaderFirst(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new EchoWorker();
          created.push(worker);
          return worker;
        },
      });
      await using pool = new Pool({ kind: echo(), store, clock: globalThis });
      // The owner starts its worker once it owns.
      await waitFor(() => assert.equal(created.length, 1), {
        signal: t.signal,
        interval: 10,
      });
      const stop = new AbortController();
      const waiting = pool.run('never', { signal: stop.signal });

      stop.abort();
      await assert.rejects(waiting, { name: 'AbortError' });
      assert.equal(created[0]!.dead, false);

      created[0]!.release();
      await owner.ready();
      assert.equal(await pool.run('later'), 'later');
      assert.equal(created.length, 1);
    });

    test('disposing a Pool ends its waiting runs with DisposedError, cancels their jobs, and refuses later jobs', async (t) => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const gate = new Latch();
      class Gated extends EchoWorker {
        override async run(text: string): Promise<string> {
          await gate.wait();
          return super.run(text);
        }
      }
      await using owner = lending(store, {
        size: new Fixed(1),
        startup: new Parallel(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new Gated();
          worker.release();
          return worker;
        },
      });
      const pool = new Pool({ kind: echo(), store, clock: globalThis });
      await using sending = await sender(store);
      await owner.ready();
      const runs = Promise.allSettled(
        ['x', 'y', 'z'].map((text) => pool.run(text)),
      );
      await waitFor(
        async () =>
          assert.equal((await sending.jobs.findJobs(queue)).length, 3),
        { signal: t.signal, interval: 10 },
      );

      await pool[Symbol.asyncDispose]();
      try {
        for (const outcome of await runs) {
          assert.equal(outcome.status, 'rejected');
          assert.ok(outcome.reason instanceof DisposedError);
        }
        assert.deepEqual(
          (await sending.jobs.findJobs(queue)).map(({ state }) => state),
          ['cancelled', 'cancelled', 'cancelled'],
        );
        await assert.rejects(pool.run('after'), DisposedError);
      } finally {
        gate.open();
      }
    });

    test('a job joins a worker that starts before it starts one in an empty slot', async (t) => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const clock = createClock(Date.now());
      const created: EchoWorker[] = [];
      await using owner = lendingOn(clock, store, {
        size: new Fixed(2),
        startup: new Parallel(),
        eviction: new IdleTimeout({ after: 30_000 }),
        create: () => {
          const worker = new EchoWorker();
          // The worker that the back-off starts waits for the test.
          if (created.length !== 2) worker.release();
          created.push(worker);
          return worker;
        },
      });
      await using pool = new Pool({ kind: echo(), store, clock });
      await owner.ready();
      // An early exit puts slot 0 in a back-off, after which it starts a worker
      // that warms up while no job has it. The eviction lets the idle worker of
      // slot 1 go, which leaves its slot empty.
      created[0]!.kill();
      await created[0]!.exited();
      await clock.tickAsync(1_000);
      await waitFor(() => assert.equal(created.length, 3), {
        signal: t.signal,
        interval: 5,
      });
      await clock.tickAsync(30_000);
      await created[1]!.exited();
      assert.deepEqual(owner.stats, {
        starting: 1,
        idle: 0,
        lent: 0,
        waiting: 0,
      });

      const job = pool.run('joined');
      try {
        await waitFor(() => assert.equal(owner.stats.waiting, 1), {
          signal: t.signal,
          interval: 10,
        });
        created[2]!.release();
        assert.equal(await job, 'joined');
        assert.equal(created.length, 3);
      } finally {
        created[2]!.release();
        await Promise.allSettled([job]);
      }
    });

    test('a Pool whose store is a postgres:// address is refused with a TypeError and opens no file', async () => {
      await using folder = await new TemporaryFiles().directory('pool-');

      assert.throws(
        () =>
          new Pool({
            kind: echo(),
            store: 'postgres://localhost/pool',
            clock: globalThis,
          }),
        TypeError,
      );
      assert.deepEqual(await readdir(folder.path, { recursive: true }), []);
    });

    test("a Pool whose kind's expireInSeconds the store refuses rejects start with the store's failure", async () => {
      await using folder = await new TemporaryFiles().directory('pool-');
      await using pool = new Pool({
        kind: new WorkerKind<string, string>({
          name: 'echo',
          revision: 1,
          policy: 'standard',
          retryLimit: 0,
          expireInSeconds: 25 * 60 * 60,
        }),
        store: join(folder.path, 'store.sqlite'),
        clock: globalThis,
      });

      await assert.rejects(
        pool.start('never'),
        /expiration cannot exceed 24 hours/,
      );
    });

    test('a job that one Pool starts gives its output to the handle of another Pool on the store', async () => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      await using owner = lending(store, {
        size: new Fixed(1),
        startup: new Parallel(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new EchoWorker();
          worker.release();
          return worker;
        },
      });
      await using first = new Pool({ kind: echo(), store, clock: globalThis });
      await using second = new Pool({ kind: echo(), store, clock: globalThis });
      await owner.ready();

      const started = await first.start('shared');
      assert.equal(await second.handle(started.id).result(), 'shared');
      assert.equal(await started.result(), 'shared');
    });

    test('a failed job rejects its result with JobFailedError, which carries the name and the message of the failure', async () => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      class Failing extends EchoWorker {
        override run(text: string): Promise<string> {
          return Promise.reject(new RangeError(`no ${text}`));
        }
      }
      await using owner = lending(store, {
        size: new Fixed(1),
        startup: new Parallel(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new Failing();
          worker.release();
          return worker;
        },
      });
      await using pool = new Pool({ kind: echo(), store, clock: globalThis });
      await owner.ready();

      await assert.rejects(pool.run('line'), (error) => {
        assert.ok(error instanceof JobFailedError);
        assert.deepEqual(error.failure, {
          name: 'RangeError',
          message: 'no line',
        });
        return true;
      });
    });

    test('the handle of an id that the store does not have rejects its result with JobNotFoundError', async () => {
      await using folder = await new TemporaryFiles().directory('pool-');
      await using pool = new Pool({
        kind: echo(),
        store: join(folder.path, 'store.sqlite'),
        clock: globalThis,
      });

      await assert.rejects(
        pool.handle(randomUUID()).result(),
        JobNotFoundError,
      );
    });

    test('a cancelled job that waits never runs, and its result rejects with JobCancelledError', async () => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      await using pool = new Pool({ kind: echo(), store, clock: globalThis });
      // No owner yet, so the job waits in the store.
      const dropped = await pool.start('dropped');

      await dropped.cancel();

      await assert.rejects(dropped.result(), JobCancelledError);
      const ran: string[] = [];
      class Recording extends EchoWorker {
        override run(text: string): Promise<string> {
          ran.push(text);
          return super.run(text);
        }
      }
      await using owner = lending(store, {
        size: new Fixed(1),
        startup: new Parallel(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new Recording();
          worker.release();
          return worker;
        },
      });
      await owner.ready();
      assert.equal(await pool.run('later'), 'later');
      assert.deepEqual(ran, ['later']);
    });

    test('identical inputs of an exclusive kind share one job, and the cancel of one handle is a leave', async () => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const once = () =>
        new WorkerKind<string, string>({
          name: 'once',
          revision: 1,
          policy: 'exclusive',
          retryLimit: 0,
          expireInSeconds: 60,
        });
      const gate = new Latch();
      const ran: string[] = [];
      class Gated extends EchoWorker {
        override async run(text: string): Promise<string> {
          ran.push(text);
          await gate.wait();
          return super.run(text);
        }
      }
      await using owner = new PoolWorkers({
        kind: once(),
        store,
        clock: globalThis,
        size: new Fixed(2),
        startup: new Parallel(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new Gated();
          worker.release();
          return worker;
        },
      });
      await using pool = new Pool({ kind: once(), store, clock: globalThis });
      await owner.ready();

      const left = await pool.start('x');
      const kept = await pool.start('x');
      assert.equal(kept.id, left.id);
      await left.cancel();
      gate.open();

      assert.equal(await kept.result(), 'x');
      assert.equal(await left.result(), 'x');
      assert.deepEqual(ran, ['x']);
    });

    test('stats count the jobs of the kind that wait and that run', async (t) => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const gate = new Latch();
      class Gated extends EchoWorker {
        override async run(text: string): Promise<string> {
          await gate.wait();
          return super.run(text);
        }
      }
      await using owner = lending(store, {
        size: new Fixed(1),
        startup: new Parallel(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new Gated();
          worker.release();
          return worker;
        },
      });
      await using pool = new Pool({ kind: echo(), store, clock: globalThis });
      await owner.ready();
      const handles = await Array.fromAsync(['a', 'b', 'c'], (text) =>
        pool.start(text),
      );
      try {
        // The counts lag up to one pass of the store's monitor, a second.
        await waitFor(
          async () =>
            assert.deepEqual(await pool.stats(), { waiting: 2, running: 1 }),
          { signal: t.signal, interval: 100 },
        );
        gate.open();
        await Promise.all(handles.map((handle) => handle.result()));
        await waitFor(
          async () =>
            assert.deepEqual(await pool.stats(), { waiting: 0, running: 0 }),
          { signal: t.signal, interval: 100 },
        );
      } finally {
        gate.open();
      }
    });

    test('a job runs and its output arrives on a clock that stands still: the wakes carry the news, not the backstops', async () => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const clock = createClock(Date.now());
      await using owner = lendingOn(clock, store, {
        size: new Fixed(1),
        startup: new Parallel(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new EchoWorker();
          worker.release();
          return worker;
        },
      });
      await using pool = new Pool({ kind: echo(), store, clock });
      await owner.ready();
      const began = clock.now;

      assert.equal(await pool.run('woken'), 'woken');
      assert.equal(clock.now, began);
    });

    test('a job that a Pool starts runs on a clock that stands still before any caller waits for its output', async (t) => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const clock = createClock(Date.now());
      await using owner = lendingOn(clock, store, {
        size: new Fixed(1),
        startup: new Parallel(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new EchoWorker();
          worker.release();
          return worker;
        },
      });
      await using pool = new Pool({ kind: echo(), store, clock });
      await using reading = await sender(store, clock);
      await owner.ready();

      const started = await pool.start('early');

      // No result waits, so only the wake of the start tells the owner.
      await waitFor(
        async () => {
          const [job] = await reading.jobs.findJobs(queue, { id: started.id });
          assert.equal(job?.state, 'completed');
        },
        { signal: t.signal, interval: 10 },
      );
      assert.equal(await started.result(), 'early');
    });

    test('a job that a Pool starts while the owner reads the store starts on a free worker, on a clock that stands still', async (t) => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const clock = createClock(Date.now());
      const held = new Latch();
      const ran: string[] = [];
      class Holding extends EchoWorker {
        override async run(text: string): Promise<string> {
          ran.push(text);
          if (text === 'a') await held.wait();
          return super.run(text);
        }
      }
      await using owner = lendingOn(clock, store, {
        size: new Fixed(2),
        startup: new Parallel(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new Holding();
          worker.release();
          return worker;
        },
      });
      await using pool = new Pool({ kind: echo(), store, clock });
      await owner.ready();
      // The owner's first fetch that finds a job gives it back only when the
      // test lets it, as a store on a slow disk does.
      const reading = new Latch();
      const answer = new Latch();
      let holding = true;
      const fetch = SqliteJobQueue.prototype.fetch;
      t.mock.method(
        SqliteJobQueue.prototype,
        'fetch',
        async function (
          this: SqliteJobQueue,
          ...args: Parameters<SqliteJobQueue['fetch']>
        ) {
          const jobs = await fetch.apply(this, args);
          if (holding && jobs.length > 0) {
            holding = false;
            reading.open();
            await answer.wait();
          }
          return jobs;
        },
      );
      try {
        await pool.start('a');
        await untilAborted(reading.wait(), t.signal);

        // The news of b reaches the owner while its fetch of a is out.
        await pool.start('b');
        await setTimeout(100);
        answer.open();

        await waitFor(() => assert.deepEqual(ran, ['a', 'b']), {
          signal: t.signal,
          interval: 10,
        });
      } finally {
        answer.open();
        held.open();
      }
    });

    test('a result that reads its job before the output still gets the output told during its read, on a clock that stands still', async (t) => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const clock = createClock(Date.now());
      const gate = new Latch();
      class Gated extends EchoWorker {
        override async run(text: string): Promise<string> {
          await gate.wait();
          return super.run(text);
        }
      }
      await using owner = lendingOn(clock, store, {
        size: new Fixed(1),
        startup: new Parallel(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new Gated();
          worker.release();
          return worker;
        },
      });
      await using pool = new Pool({ kind: echo(), store, clock });
      await using sending = await sender(store, clock);
      await owner.ready();
      const started = await pool.start('told');
      await waitFor(() => assert.equal(owner.stats.lent, 1), {
        signal: t.signal,
        interval: 10,
      });
      // The result's first read of the job gives the job back only when the
      // test lets it, as a store on a slow disk does.
      const reading = new Latch();
      const answer = new Latch();
      let holding = true;
      const findJobs = SqliteJobQueue.prototype.findJobs;
      t.mock.method(
        SqliteJobQueue.prototype,
        'findJobs',
        async function (
          this: SqliteJobQueue,
          ...args: Parameters<SqliteJobQueue['findJobs']>
        ) {
          const jobs = await findJobs.apply(this, args);
          if (holding && args[1]?.id === started.id) {
            holding = false;
            reading.open();
            await answer.wait();
          }
          return jobs;
        },
      );
      try {
        const output = started.result();
        await untilAborted(reading.wait(), t.signal);

        // The output is told while the result's read of the running job is
        // out.
        gate.open();
        await waitFor(
          async () => {
            const [job] = await sending.jobs.findJobs(queue, {
              id: started.id,
            });
            assert.equal(job?.state, 'completed');
          },
          { signal: t.signal, interval: 10 },
        );
        await setTimeout(100);
        answer.open();

        assert.equal(await output, 'told');
      } finally {
        answer.open();
        gate.open();
      }
    });

    test('a Pool tells the owners of its waiting job again, so an owner that missed the wake runs it', async () => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      // The owner's clock stands still, so its own backstop never reads the
      // store.
      const clock = createClock(Date.now());
      await using owner = lendingOn(clock, store, {
        size: new Fixed(1),
        startup: new Parallel(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new EchoWorker();
          worker.release();
          return worker;
        },
      });
      await owner.ready();
      // The job reaches the store with no wake, as when its sender ends
      // between the send and the notify.
      await using sending = await sender(store, clock);
      const id = await sending.jobs.send(queue, { input: 'missed' });
      assert.ok(id, 'the store took the job');
      await using pool = new Pool({ kind: echo(), store, clock: globalThis });

      assert.equal(await pool.handle(id).result(), 'missed');
    });
  },
);

// A caller whose program is gone cancels its jobs (ADR 0021). The owner runs
// in the test process with HeldWorkers, on the real clock, since each caller
// is another program, a Host with settings.call.
describe(
  'Pool and a caller whose program is gone',
  { concurrency: true },
  () => {
    const heldOwner = (
      store: string,
      workers: HeldWorkers,
      policy: 'standard' | 'exclusive',
    ) =>
      new PoolWorkers({
        kind: new WorkerKind<{ id: string }, { id: string }>({
          name: 'echo',
          revision: 1,
          policy,
          retryLimit: 0,
          expireInSeconds: 60,
        }),
        store,
        clock: globalThis,
        create: workers.create,
        size: new Fixed(1),
        startup: new Parallel(),
        eviction: new NoEviction(),
      });

    test('a standard job whose caller program dies while the job runs loses its worker at once, and the store cancels it', async (t) => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const workers = new HeldWorkers();
      const owner = heldOwner(store, workers, 'standard');
      try {
        await owner.ready();
        await using caller = new Host(store, {
          workers: 0,
          retryLimit: 0,
          call: { id: 'gone' },
        });
        await untilRunning(t, workers, 'gone');

        caller.kill();
        await caller.closed();

        await waitFor(() => assert.equal(workers.killed('gone'), true), {
          signal: t.signal,
          interval: 5,
        });
        await using sending = await sender(store);
        await waitFor(
          async () => {
            const [job] = await sending.jobs.findJobs(queue);
            assert.equal(job?.state, 'cancelled');
          },
          { signal: t.signal, interval: 10 },
        );
      } finally {
        workers.answerAll();
        await owner[Symbol.asyncDispose]();
      }
    });

    test('a standard run whose caller program is gone before the owner starts its job never runs', async (t) => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const workers = new HeldWorkers();
      const owner = heldOwner(store, workers, 'standard');
      try {
        await owner.ready();
        await using pool = new Pool({
          kind: new WorkerKind<{ id: string }, { id: string }>({
            name: 'echo',
            revision: 1,
            policy: 'standard',
            retryLimit: 0,
            expireInSeconds: 60,
          }),
          store,
          clock: globalThis,
        });
        await using sending = await sender(store);
        const busy = await pool.start({ id: 'busy' });
        await untilRunning(t, workers, 'busy');
        await using caller = new Host(store, {
          workers: 0,
          retryLimit: 0,
          call: { id: 'late' },
        });
        // The job of the run waits in the store while the only worker is busy.
        await waitFor(
          async () =>
            assert.equal((await sending.jobs.findJobs(queue)).length, 2),
          { signal: t.signal, interval: 10 },
        );

        caller.kill();
        await caller.closed();
        workers.answer('busy');

        assert.deepEqual(await busy.result(), { id: 'busy' });
        await waitFor(
          async () =>
            assert.deepEqual(
              (await sending.jobs.findJobs(queue))
                .map(({ state }) => state)
                .toSorted(),
              ['cancelled', 'completed'],
            ),
          { signal: t.signal, interval: 10 },
        );
        assert.equal(workers.running('late'), false);
      } finally {
        workers.answerAll();
        await owner[Symbol.asyncDispose]();
      }
    });

    test('an exclusive job whose caller program dies runs to its end, as the caller only left a job that others may share', async (t) => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const workers = new HeldWorkers();
      const owner = heldOwner(store, workers, 'exclusive');
      try {
        await owner.ready();
        await using caller = new Host(store, {
          workers: 0,
          retryLimit: 0,
          policy: 'exclusive',
          call: { id: 'shared' },
        });
        await untilRunning(t, workers, 'shared');

        caller.kill();
        await caller.closed();
        workers.answer('shared');

        await using sending = await sender(store);
        await waitFor(
          async () => {
            const [job] = await sending.jobs.findJobs(queue);
            assert.equal(job?.state, 'completed');
          },
          { signal: t.signal, interval: 10 },
        );
        assert.equal(workers.killed('shared'), false);
      } finally {
        workers.answerAll();
        await owner[Symbol.asyncDispose]();
      }
    });

    test("disposing a Pool while its run's job runs kills that job's worker at once, on a clock that stands still", async (t) => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const clock = createClock(Date.now());
      const gate = new Latch();
      const created: EchoWorker[] = [];
      class Gated extends EchoWorker {
        override async run(text: string): Promise<string> {
          await gate.wait();
          return super.run(text);
        }
      }
      await using owner = lendingOn(clock, store, {
        size: new Fixed(1),
        startup: new Parallel(),
        eviction: new NoEviction(),
        create: () => {
          const worker = new Gated();
          worker.release();
          created.push(worker);
          return worker;
        },
      });
      const pool = new Pool({ kind: echo(), store, clock });
      await owner.ready();
      // The disposal rejects the run with DisposedError.
      const run = Promise.allSettled([pool.run('held')]);
      try {
        await waitFor(() => assert.equal(owner.stats.lent, 1), {
          signal: t.signal,
          interval: 5,
        });

        // No touch comes on this clock, so only the closed connection to the
        // caller tells the owner.
        await pool[Symbol.asyncDispose]();

        await waitFor(() => assert.equal(created[0]!.dead, true), {
          signal: t.signal,
          interval: 5,
        });
      } finally {
        gate.open();
        await run;
      }
    });

    test('a job that start sent runs to its end after the program that started it dies', async (t) => {
      await using folder = await new TemporaryFiles().directory('pool-');
      const store = join(folder.path, 'store.sqlite');
      const workers = new HeldWorkers();
      const owner = heldOwner(store, workers, 'standard');
      try {
        await owner.ready();
        await using starter = new Host(store, {
          workers: 0,
          retryLimit: 0,
          call: { id: 'started' },
          start: true,
        });
        await untilRunning(t, workers, 'started');

        starter.kill();
        await starter.closed();
        workers.answer('started');

        await using sending = await sender(store);
        await waitFor(
          async () => {
            const [job] = await sending.jobs.findJobs(queue);
            assert.equal(job?.state, 'completed');
          },
          { signal: t.signal, interval: 10 },
        );
        assert.equal(workers.killed('started'), false);
      } finally {
        workers.answerAll();
        await owner[Symbol.asyncDispose]();
      }
    });
  },
);

describe('PoolWorkers on a fake clock', { concurrency: true }, () => {
  test('a running job that the store cancels loses its worker at the next touch, and the other running job keeps its own', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const clock = createClock(Date.now());
    const workers = new HeldWorkers();
    await using owner = await ownerOn(t, clock, folder.path, workers, {
      workers: 2,
      expireInSeconds: 60,
    });
    await using pool = new Pool({
      kind: owner.kind,
      store: owner.store,
      clock,
    });
    const a = await pool.start({ id: 'a' });
    const b = await pool.start({ id: 'b' });
    await untilRunning(t, workers, 'a', 'b');

    await a.cancel();
    await runFor(clock, 5_000);

    assert.equal(workers.killed('a'), true);
    assert.equal(workers.killed('b'), false);
    // The killed worker's slot takes the next job on a new worker, while b
    // still runs.
    const c = await pool.start({ id: 'c' });
    await untilRunning(t, workers, 'c');
    assert.notEqual(workers.of('c'), workers.of('a'));
    workers.answer('b');
    workers.answer('c');
    await assert.rejects(a.result(), JobCancelledError);
    assert.deepEqual(await b.result(), { id: 'b' });
    assert.deepEqual(await c.result(), { id: 'c' });
  });

  test('two jobs that end together free both slots for the next two jobs, with no wait for the backstop', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const clock = createClock(Date.now());
    const workers = new HeldWorkers();
    await using owner = await ownerOn(t, clock, folder.path, workers, {
      workers: 2,
      expireInSeconds: 60,
    });
    await using pool = new Pool({
      kind: owner.kind,
      store: owner.store,
      clock,
    });
    await using sending = await sender(owner.store, clock);
    await pool.start({ id: 'a' });
    await pool.start({ id: 'b' });
    await untilRunning(t, workers, 'a', 'b');
    // c and d reach the store with no wake, so a fetch of them can only come
    // from the ends of a and b.
    await sending.jobs.send(queue, { input: { id: 'c' } });
    await sending.jobs.send(queue, { input: { id: 'd' } });

    workers.answer('a');
    workers.answer('b');

    // The fake clock stands still: only the ends of a and b can wake the owner.
    await waitFor(
      () => {
        for (const id of ['c', 'd'])
          assert.ok(workers.running(id), `job ${id} runs`);
      },
      { signal: t.signal, interval: 5 },
    );
  });

  test("the owner kills the worker of a job at the kind's expireInSeconds, not before, and fails the job", async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const clock = createClock(Date.now());
    const workers = new HeldWorkers();
    await using owner = await ownerOn(t, clock, folder.path, workers, {
      workers: 1,
      expireInSeconds: 7,
    });
    await using pool = new Pool({
      kind: owner.kind,
      store: owner.store,
      clock,
    });
    await using sending = await sender(owner.store, clock);
    const hung = await pool.start({ id: 'hung' });
    await untilRunning(t, workers, 'hung');
    // The owner fetched the job at once, with the clock still, so its time
    // limit counts from now.
    const limit = clock.now + 7_000;

    await runFor(clock, limit - 10 - clock.now);
    const [early] = await sending.jobs.findJobs(queue);
    assert.deepEqual([early?.state, workers.killed('hung')], ['active', false]);
    await runFor(clock, 20);

    assert.equal(workers.killed('hung'), true);
    await assert.rejects(hung.result(), (error) => {
      assert.ok(error instanceof JobFailedError);
      assert.deepEqual(error.failure, {
        name: 'Error',
        message: 'handler execution exceeded 7s',
      });
      return true;
    });
    // The slot of the killed worker runs the next job on a new worker.
    const next = await pool.start({ id: 'next' });
    await untilRunning(t, workers, 'next');
    assert.notEqual(workers.of('next'), workers.of('hung'));
    workers.answer('next');
    assert.deepEqual(await next.result(), { id: 'next' });
  });

  test('the owner touches each running job every 5 s, so jobs that run past their heartbeat of 10 s stay active and complete', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const clock = createClock(Date.now());
    const workers = new HeldWorkers();
    await using owner = await ownerOn(t, clock, folder.path, workers, {
      workers: 2,
      expireInSeconds: 60,
    });
    await using pool = new Pool({
      kind: owner.kind,
      store: owner.store,
      clock,
    });
    await using sending = await sender(owner.store, clock);
    const jobs = [await pool.start({ id: 'a' }), await pool.start({ id: 'b' })];
    await untilRunning(t, workers, 'a', 'b');

    await runFor(clock, 6_000);
    const touched = await sending.jobs.findJobs(queue);
    assert.equal(touched.length, 2);
    for (const job of touched) {
      const at = job.heartbeatOn!.getTime() - job.startedOn!.getTime();
      assert.ok(at >= 5_000 && at < 5_100, `touched at ${at}`);
    }
    await runFor(clock, 19_000);
    const running = await sending.jobs.findJobs(queue);
    assert.deepEqual(
      running.map((job) => job.state),
      ['active', 'active'],
    );
    workers.answer('a');
    workers.answer('b');

    assert.deepEqual(await Promise.all(jobs.map((job) => job.result())), [
      { id: 'a' },
      { id: 'b' },
    ]);
  });

  test("an owner that disposes while its worker hangs ends its disposal at the kind's expireInSeconds and fails the job", async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const clock = createClock(Date.now());
    const workers = new HeldWorkers();
    await using owner = await ownerOn(t, clock, folder.path, workers, {
      workers: 1,
      expireInSeconds: 7,
    });
    await using pool = new Pool({
      kind: owner.kind,
      store: owner.store,
      clock,
    });
    const hung = await pool.start({ id: 'hung' });
    await untilRunning(t, workers, 'hung');
    // The owner fetched the job at once, with the clock still, so its time
    // limit counts from now.
    const limit = clock.now + 7_000;

    let disposed = false;
    const disposal = owner.dispose().finally(() => {
      disposed = true;
    });
    await runFor(clock, limit - 10 - clock.now);
    assert.equal(disposed, false);
    await runFor(clock, 20);
    await untilAborted(disposal, t.signal);

    assert.equal(workers.killed('hung'), true);
    await assert.rejects(hung.result(), (error) => {
      assert.ok(error instanceof JobFailedError);
      assert.deepEqual(error.failure, {
        name: 'Error',
        message: 'handler execution exceeded 7s',
      });
      return true;
    });
  });
});

type FakeClock = ReturnType<typeof createClock>;
type BossClock = NonNullable<SqliteJobQueueOptions['clock']>;

/**
 * Workers in the test process. run holds each job until the test answers it,
 * and kill only records the kill and ends the worker, so a killed job never
 * answers.
 */
class HeldWorkers {
  readonly #jobs = new Map<string, HeldJob>();
  readonly #killed = new Set<HeldWorker>();

  create = (): HeldWorker => new HeldWorker(this.#jobs, this.#killed);

  running(id: string): boolean {
    return this.#jobs.has(id);
  }

  /** The worker that ran the job. */
  of(id: string): HeldWorker {
    return this.#job(id).worker;
  }

  /** Whether the worker that ran the job was killed. */
  killed(id: string): boolean {
    return this.#killed.has(this.of(id));
  }

  answer(id: string): void {
    this.#job(id).answer();
  }

  answerAll(): void {
    for (const { answer } of this.#jobs.values()) answer();
  }

  #job(id: string): HeldJob {
    const job = this.#jobs.get(id);
    assert.ok(job, `job ${id} never ran`);
    return job;
  }
}

interface HeldJob {
  readonly worker: HeldWorker;
  readonly answer: () => void;
}

class HeldWorker implements Worker<{ id: string }, { id: string }> {
  readonly #exit = new Latch();
  readonly #jobs: Map<string, HeldJob>;
  readonly #killed: Set<HeldWorker>;

  constructor(jobs: Map<string, HeldJob>, killed: Set<HeldWorker>) {
    this.#jobs = jobs;
    this.#killed = killed;
  }

  run(input: { id: string }): Promise<{ id: string }> {
    const answered = Promise.withResolvers<{ id: string }>();
    this.#jobs.set(input.id, {
      worker: this,
      answer: () => answered.resolve({ id: input.id }),
    });
    return answered.promise;
  }

  exited(): Promise<void> {
    return this.#exit.wait();
  }

  kill(): void {
    this.#killed.add(this);
    this.#exit.open();
  }

  async close(): Promise<void> {
    this.#exit.open();
  }
}

/** PoolWorkers of the "echo" kind in the test process, once it owns. */
async function ownerOn(
  t: TestContext,
  clock: FakeClock,
  folder: string,
  workers: HeldWorkers,
  settings: { workers: number; expireInSeconds: number },
) {
  const store = join(folder, 'store.sqlite');
  let created = 0;
  const kind = new WorkerKind<{ id: string }, { id: string }>({
    name: 'echo',
    revision: 1,
    policy: 'standard',
    retryLimit: 0,
    expireInSeconds: settings.expireInSeconds,
  });
  const owner = new PoolWorkers({
    kind,
    store,
    clock,
    create: () => {
      created++;
      return workers.create();
    },
    size: new Fixed(settings.workers),
    startup: new Parallel(),
    eviction: new NoEviction(),
  });
  await waitFor(() => assert.ok(created > 0, 'the owner'), {
    signal: t.signal,
    interval: 5,
  });
  return {
    store,
    kind,
    /** Disposes the owner: its running jobs end by themselves or at the time limit. */
    dispose: () => owner[Symbol.asyncDispose](),
    /** Answers every held job first, so a failed test does not wait for a time limit on a clock that stands still. */
    [Symbol.asyncDispose]: () => {
      workers.answerAll();
      return owner[Symbol.asyncDispose]();
    },
  };
}

/**
 * Moves the fake clock `ms` milliseconds, 10 ms at a time, with a turn of the
 * event loop after each step for the store's SQLite work.
 */
async function runFor(clock: FakeClock, ms: number): Promise<void> {
  const end = clock.now + ms;
  while (clock.now < end) {
    await clock.tickAsync(10);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Waits in real time, with the clock still, until each job of `ids` runs on a
 * worker: the owner hears of each job at once, and a worker's start and the
 * election take real I/O.
 */
async function untilRunning(
  t: TestContext,
  workers: HeldWorkers,
  ...ids: string[]
): Promise<void> {
  await waitFor(
    () => {
      for (const id of ids) assert.ok(workers.running(id), `job ${id} runs`);
    },
    { signal: t.signal, interval: 5 },
  );
}

/** pg-boss's clock, which the queue takes, on the fake clock. */
function bossClock(clock: FakeClock): BossClock {
  // pg-boss's timers are opaque, and a method's parameters are bivariant, so
  // the fake clock's timers fit them.
  const timers: Omit<BossClock, 'now'> = clock;
  return {
    now: () => clock.now,
    setTimeout: (callback, ms) => timers.setTimeout(callback, ms),
    clearTimeout: (timer) => timers.clearTimeout(timer),
    setInterval: (callback, ms) => timers.setInterval(callback, ms),
    clearInterval: (timer) => timers.clearInterval(timer),
  };
}

/** Waits until the store has `count` jobs of the queue, each settled or cancelled. */
function settled(t: TestContext, jobs: SqliteJobQueue, count: number) {
  return waitFor(
    async () => {
      const found = await jobs.findJobs(queue);
      assert.equal(found.length, count);
      for (const job of found)
        assert.match(job.state, /^(completed|failed|cancelled)$/);
      return found;
    },
    { signal: t.signal, interval: 20 },
  );
}

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

/** PoolWorkers of the "echo" kind, whose input and output are a line, on the real clock. */
function lending(
  store: string,
  options: Parameters<typeof lendingOn>[2],
): PoolWorkers<string, string> {
  return lendingOn(globalThis, store, options);
}

/** PoolWorkers of the "echo" kind, whose input and output are a line, on `clock`. */
function lendingOn(
  clock: WallClock,
  store: string,
  options: {
    size: Sizing;
    startup: Startup;
    eviction: Eviction;
    create: () => Worker<string, string>;
  },
): PoolWorkers<string, string> {
  return new PoolWorkers({ kind: echo(), store, clock, ...options });
}

/** The "echo" kind, whose input and output are a line, run once, for at most 60 s. */
function echo(): WorkerKind<string, string> {
  return new WorkerKind<string, string>({
    name: 'echo',
    revision: 1,
    policy: 'standard',
    retryLimit: 0,
    expireInSeconds: 60,
  });
}

/**
 * A worker of a real process, which warms up as EchoWorker does, and whose
 * run does `work` on the test's clock in place of a line to the process, as a
 * job of Pool.use did its work beside the worker.
 */
class Working extends EchoWorker {
  readonly #work: () => Promise<void>;

  constructor(work: () => Promise<void>) {
    super();
    this.#work = work;
  }

  override async run(text: string): Promise<string> {
    await this.#work();
    return text;
  }
}

/**
 * An EchoWorker that answers the line "pid" with its process id, and whose
 * run of a line in `holds` waits for that latch first.
 */
class Pid extends EchoWorker {
  readonly #holds: Record<string, Latch>;

  constructor(holds: Record<string, Latch>) {
    super();
    this.#holds = holds;
  }

  override async run(text: string): Promise<string> {
    await this.#holds[text]?.wait();
    return text === 'pid' ? String(this.pid) : super.run(text);
  }
}

/**
 * An EchoWorker whose run waits for `hold` of its line before it sends the
 * line, and pushes the time of `clock` to `ends` when the run ends, so a test
 * knows when the idle wait of the worker began.
 */
class Held extends EchoWorker {
  readonly #hold: (text: string) => Promise<void>;
  readonly #clock: FakeClock;
  readonly #ends: number[];

  constructor(
    hold: (text: string) => Promise<void>,
    clock: FakeClock,
    ends: number[],
  ) {
    super();
    this.#hold = hold;
    this.#clock = clock;
    this.#ends = ends;
  }

  override async run(text: string): Promise<string> {
    await this.#hold(text);
    const echoed = await super.run(text);
    this.#ends.push(this.#clock.now);
    return echoed;
  }
}

/**
 * Moves the fake clock of the owners 10 ms at a time until `done` holds, and
 * lets the event loop turn between two moves, so that the real worker
 * processes report on time and the store settles each job between two moves.
 * While a worker of an owner starts, the clock waits, so a warm-up takes no
 * time on the clock, as an owner measures no job until its workers are ready.
 * Fails when `limit` ms of the clock pass first.
 */
async function drive(
  clock: FakeClock,
  owners: readonly PoolWorkers<string, string>[],
  done: () => boolean,
  limit: number,
): Promise<void> {
  const end = clock.now + limit;
  while (!done()) {
    if (clock.now >= end)
      throw new Error(`Not done after ${limit} ms on the clock`);
    if (owners.every((owner) => owner.stats.starting === 0))
      await clock.tickAsync(10);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * A closed load of `clients` clients, as loops over Pool.run make: it starts
 * one job for each client, and the run of each job starts the next one at its
 * end until the load stops, so as many jobs as there are clients are always
 * waiting or running. A start is a write to the store, so it takes no time on
 * the clock.
 */
function closedLoad(pool: Pool<string, string>, clients: number) {
  const stopped = new AbortController();
  let sentJobs = 0;
  let ranJobs = 0;
  const send = async (): Promise<void> => {
    sentJobs++;
    await pool.start('job');
  };
  return {
    start: async (): Promise<void> => {
      await Array.fromAsync({ length: clients }, send);
    },
    /** The work of a run: the job, then the next job of its client. */
    work: (job: () => Promise<unknown>) => async (): Promise<void> => {
      await job();
      ranJobs++;
      if (!stopped.signal.aborted) await send();
    },
    stop: (): void => stopped.abort(),
    /** Whether each job that the load sent ran. */
    drained: (): boolean => ranJobs === sentJobs,
  };
}

/** Moves the fake clock of the owners `ms` milliseconds, as drive does. */
async function driveFor(
  clock: FakeClock,
  owners: readonly PoolWorkers<string, string>[],
  ms: number,
): Promise<void> {
  const end = clock.now + ms;
  await drive(clock, owners, () => clock.now >= end, ms + 10);
}

/**
 * Moves the fake clock of an owner, as drive does, until the owner lets one
 * of `workers` go: it holds fewer than they are, and all of them ran when
 * this began. Then it waits for that worker's real exit with the clock still,
 * so that the owner takes no next step on the clock meanwhile. It does not
 * compare `alive(workers)` with what the owner holds: a worker counts as
 * alive only until its real exit, so that holds for a moment, and a busy
 * machine can miss it.
 */
async function untilDropped(
  t: TestContext,
  clock: FakeClock,
  owner: PoolWorkers<string, string>,
  workers: readonly EchoWorker[],
  limit: number,
): Promise<void> {
  await drive(clock, [owner], () => holds(owner) < workers.length, limit);
  await untilExited(t, owner, workers);
}

/**
 * Waits in real time, with the clock still, until each of `workers` that the
 * owner let go has exited: no more of them run than the owner holds. A worker
 * exits some milliseconds of real time after the owner closes it.
 */
async function untilExited(
  t: TestContext,
  owner: PoolWorkers<string, string>,
  workers: readonly EchoWorker[],
): Promise<void> {
  await waitFor(() => assert.ok(alive(workers) <= holds(owner)), {
    signal: t.signal,
    interval: 5,
  });
}

/** The workers that have not exited. */
function alive(workers: readonly EchoWorker[]): number {
  return workers.filter((worker) => !worker.dead).length;
}

/** The workers that the owner holds: those that start, idle or are lent. */
function holds(owner: PoolWorkers<string, string>): number {
  const { starting, idle, lent } = owner.stats;
  return starting + idle + lent;
}

/**
 * On disposal, owns the store's pool of the "echo" kind and hands it over. A
 * host that a test killed while it owned leaves the socket file of its
 * election pipe in the temporary folder of the system. The next owner removes
 * that file, and its hand-over removes its own (election ADR 0005). It offers
 * no worker, so it takes no job that a test left in the store. Dispose it
 * after each host of the test ended: a live owner keeps its term.
 */
function succeedLastOwner(store: string): AsyncDisposable {
  return {
    async [Symbol.asyncDispose]() {
      await using successor = lending(store, {
        size: new Fixed(0),
        startup: new OnDemand(),
        eviction: new NoEviction(),
        create: () => new EchoWorker(),
      });
      await successor.ready();
    },
  };
}
