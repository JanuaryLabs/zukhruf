import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { createClock } from '@sinonjs/fake-timers';

import { Latch, untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import {
  SqliteJobQueue,
  type SqliteJobQueueOptions,
} from '@zukhruf/sqlite-queue';
import { waitFor } from '@zukhruf/testing/async';
import { describe, test } from '@zukhruf/testing/node';

import {
  type Eviction,
  Fixed,
  LeaderFirst,
  NoEviction,
  OnDemand,
  OrderedReady,
  Parallel,
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
// alive.
const host = `
import { setTimeout as sleep } from 'node:timers/promises';
import { Fixed, NoEviction, Parallel, PoolWorkers, WorkerKind } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};

const [store, json] = process.argv.slice(1);
const settings = JSON.parse(json);

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
`;

type Report =
  | { created: true }
  | { constructed: true }
  | { started: string }
  | { refused: string }
  | { disposed: true };

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
    await using sending = await sender(store);

    for (const id of ['a', 'b', 'c', 'd', 'e', 'f'])
      await sending.jobs.send(queue, { input: { id, ms: 200 } });

    const jobs = await settled(t, sending.jobs, 6);
    assert.deepEqual(
      jobs.map((job) => [job.state, job.output]),
      jobs.map(({ data }) => [
        'completed',
        { output: { host: owner.pid, id: inputOf(data).id } },
      ]),
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
    await using sending = await sender(store);

    await sending.jobs.send(queue, { input: { id: 'done' } });
    await sending.jobs.send(queue, { input: { id: 'broken', fail: 'boom' } });

    const jobs = await settled(t, sending.jobs, 2);
    assert.deepEqual(
      Object.fromEntries(
        jobs.map((job) => [inputOf(job.data).id, [job.state, job.output]]),
      ),
      {
        done: ['completed', { output: { host: owner.pid, id: 'done' } }],
        broken: ['failed', { name: 'Error', message: 'boom' }],
      },
    );
  });

  test('with Fixed(2), the store never holds more than 2 active jobs, and holds 2 at once', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    // Disposed after the hosts, so it removes the pipe of the last owner.
    await using _successor = succeedLastOwner(store);
    await using owner = new Host(store, { workers: 2, retryLimit: 0 });
    await owner.report(owns, { signal: t.signal });
    await using sending = await sender(store);

    // Each job runs longer than the backstop, so the owner fetches again
    // while both workers are busy. The second job runs longer than the
    // first, so one worker becomes free while the other still runs.
    for (const [id, ms] of [
      ['a', 1_500],
      ['b', 2_200],
      ['c', 1_500],
      ['d', 1_500],
      ['e', 1_500],
    ] as const)
      await sending.jobs.send(queue, { input: { id, ms } });

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
    await using sending = await sender(store);
    await sending.jobs.send(queue, {
      input: { id: 'held', hangIn: owner.pid },
    });
    await owner.report((report) => 'started' in report, { signal: t.signal });

    owner.kill();
    await owner.closed();

    // The job comes back by its heartbeat of 10 s, found by a supervise and
    // monitor pass each second: the defaults of 60 s miss this bound.
    const [job] = await settled(t, sending.jobs, 1);
    assert.deepEqual(
      [job?.state, job?.output],
      ['completed', { output: { host: standby.pid, id: 'held' } }],
    );
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
    await using sending = await sender(store);
    await sending.jobs.send(queue, { input: { id: 'running', ms: 1_000 } });
    await owner.report((report) => 'started' in report, { signal: t.signal });

    owner.send('dispose');
    await owner.report((report) => 'disposed' in report, { signal: t.signal });
    await sending.jobs.send(queue, { input: { id: 'next' } });

    const jobs = await settled(t, sending.jobs, 2);
    assert.deepEqual(
      Object.fromEntries(
        jobs.map((job) => [inputOf(job.data).id, [job.state, job.output]]),
      ),
      {
        running: ['completed', { output: { host: owner.pid, id: 'running' } }],
        next: ['completed', { output: { host: standby.pid, id: 'next' } }],
      },
    );
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
    await using sending = await sender(store);
    await sending.jobs.send(queue, { input: { id: 'running', ms: 500 } });
    await owner.report((report) => 'started' in report, { signal: t.signal });

    owner.send('dispose');
    await standby.report(owns, { signal: t.signal });
    const [whenOwned] = await sending.jobs.findJobs(queue);
    assert.equal(whenOwned?.state, 'completed');
    await sending.jobs.send(queue, { input: { id: 'next' } });

    const jobs = await settled(t, sending.jobs, 2);
    assert.deepEqual(
      Object.fromEntries(
        jobs.map((job) => [inputOf(job.data).id, [job.state, job.output]]),
      ),
      {
        running: ['completed', { output: { host: owner.pid, id: 'running' } }],
        next: ['completed', { output: { host: standby.pid, id: 'next' } }],
      },
    );
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
// clock. Until Pool sends jobs (ADR 0019), the test sends them to the store
// itself, and the owner fetches a new job at its backstop.
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
    await using sending = await sender(store);
    await workers.ready();
    assert.equal(created.length, 0);

    assert.equal(await ran(t, sending.jobs, 'one'), 'one');
    assert.equal(await ran(t, sending.jobs, 'two'), 'two');
    assert.equal(created.length, 1);

    assert.deepEqual(
      await Promise.all([
        ran(t, sending.jobs, 'a'),
        ran(t, sending.jobs, 'b'),
        ran(t, sending.jobs, 'c'),
      ]),
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
    await using sending = await sender(store);
    await waitFor(() => assert.equal(created.length, 1), {
      signal: t.signal,
      interval: 10,
    });
    const job = ran(t, sending.jobs, 'during warm-up');
    await setTimeout(200);
    assert.equal(created.length, 1, 'no worker may start beside the leader');

    created[0]!.release();
    await workers.ready();
    assert.equal(created.length, 3);
    assert.equal(await job, 'during warm-up');

    process.kill(created[1]!.pid, 'SIGKILL');
    await created[1]!.exited();
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        ran(t, sending.jobs, String(index)),
      ),
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
    await using sending = await sender(store);

    await assert.rejects(ran(t, sending.jobs, 'first'), /Echo worker exited/);
    assert.equal(await ran(t, sending.jobs, 'second'), 'second');
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
    await using sending = await sender(store);
    await workers.ready();
    const run = (text: string) => ran(t, sending.jobs, text);
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
    await using sending = await sender(store);
    await waitFor(() => assert.equal(created.length, 2), {
      signal: t.signal,
      interval: 10,
    });
    // One at a time, so the store gives the slow and the fast job first.
    const ids = await Array.fromAsync(
      ['sleep 400', 'sleep 50', 'sleep 10', 'sleep 10', 'sleep 10'],
      (text) => sent(sending.jobs, text),
    );
    // The owner fetched the slow and the fast job for its two workers, which
    // warm up until the test releases them, so both jobs start together.
    // Waiting jobs make the times measurable once the slow job ends.
    await waitFor(() => assert.equal(workers.stats.waiting, 2), {
      signal: t.signal,
      interval: 10,
    });
    for (const worker of created) worker.release();

    await Promise.all(ids.map((id) => outputOf(t, sending.jobs, id)));
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
    await using sending = await sender(store);
    await workers.ready();

    process.kill(created[0]!.pid, 'SIGKILL');
    await waitFor(() => assert.equal(created.length, 3), {
      signal: t.signal,
      interval: 10,
    });
    await created[2]!.ready();

    assert.deepEqual(
      await Promise.all([ran(t, sending.jobs, 'a'), ran(t, sending.jobs, 'b')]),
      ['a', 'b'],
    );
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
    await using sending = await sender(store);
    const until = (stats: object) =>
      waitFor(() => assert.deepEqual(workers.stats, stats), {
        signal: t.signal,
        interval: 10,
      });
    await until({ starting: 2, idle: 0, lent: 0, waiting: 0 });

    // The owner takes two jobs for the workers that start; the third waits in
    // the store, not in the owner.
    const ids = await Array.fromAsync(['a', 'b', 'c'], (text) =>
      sent(sending.jobs, text),
    );
    const jobs = ids.map((id) => outputOf(t, sending.jobs, id));
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
    await using sending = await sender(store);
    await workers.ready();
    const job = ran(t, sending.jobs, 'late');
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
    await using sending = await sender(store);
    assert.equal(await ran(t, sending.jobs, 'one'), 'one');
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

describe('PoolWorkers on a fake clock', { concurrency: true }, () => {
  test('a running job that the store cancels loses its worker at the next touch, and the other running job keeps its own', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const clock = createClock(Date.now());
    const workers = new HeldWorkers();
    await using owner = await ownerOn(t, clock, folder.path, workers, {
      workers: 2,
      expireInSeconds: 60,
    });
    await using sending = await sender(owner.store, clock);
    const cancelled = await sending.jobs.send(queue, { input: { id: 'a' } });
    await sending.jobs.send(queue, { input: { id: 'b' } });
    await fetched(t, clock, workers, 'a', 'b');

    await sending.jobs.cancel(queue, cancelled!);
    await runFor(clock, 5_000);

    assert.equal(workers.killed('a'), true);
    assert.equal(workers.killed('b'), false);
    // The killed worker's slot takes the next job on a new worker, while b
    // still runs.
    await sending.jobs.send(queue, { input: { id: 'c' } });
    await fetched(t, clock, workers, 'c');
    assert.notEqual(workers.of('c'), workers.of('a'));
    workers.answer('b');
    workers.answer('c');
    const jobs = await settled(t, sending.jobs, 3);
    assert.deepEqual(
      Object.fromEntries(jobs.map((job) => [inputOf(job.data).id, job.state])),
      { a: 'cancelled', b: 'completed', c: 'completed' },
    );
  });

  test('two jobs that end together free both slots for the next two jobs, with no wait for the backstop', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const clock = createClock(Date.now());
    const workers = new HeldWorkers();
    await using owner = await ownerOn(t, clock, folder.path, workers, {
      workers: 2,
      expireInSeconds: 60,
    });
    await using sending = await sender(owner.store, clock);
    await sending.jobs.send(queue, { input: { id: 'a' } });
    await sending.jobs.send(queue, { input: { id: 'b' } });
    await fetched(t, clock, workers, 'a', 'b');
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
    await using sending = await sender(owner.store, clock);
    await sending.jobs.send(queue, { input: { id: 'hung' } });
    await fetched(t, clock, workers, 'hung');
    const limit = (await fetchedAt(sending.jobs)) + 7_000;

    await runFor(clock, limit - 10 - clock.now);
    const [early] = await sending.jobs.findJobs(queue);
    assert.deepEqual([early?.state, workers.killed('hung')], ['active', false]);
    await runFor(clock, 20);

    assert.equal(workers.killed('hung'), true);
    const [job] = await settled(t, sending.jobs, 1);
    assert.deepEqual(
      [job?.state, job?.output],
      ['failed', { name: 'Error', message: 'handler execution exceeded 7s' }],
    );
    // The slot of the killed worker runs the next job on a new worker.
    await sending.jobs.send(queue, { input: { id: 'next' } });
    await fetched(t, clock, workers, 'next');
    assert.notEqual(workers.of('next'), workers.of('hung'));
    workers.answer('next');
    await settled(t, sending.jobs, 2);
  });

  test('the owner touches each running job every 5 s, so jobs that run past their heartbeat of 10 s stay active and complete', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const clock = createClock(Date.now());
    const workers = new HeldWorkers();
    await using owner = await ownerOn(t, clock, folder.path, workers, {
      workers: 2,
      expireInSeconds: 60,
    });
    await using sending = await sender(owner.store, clock);
    await sending.jobs.send(queue, { input: { id: 'a' } });
    await sending.jobs.send(queue, { input: { id: 'b' } });
    await fetched(t, clock, workers, 'a', 'b');

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

    const jobs = await settled(t, sending.jobs, 2);
    assert.deepEqual(
      jobs.map((job) => job.state),
      ['completed', 'completed'],
    );
  });

  test("an owner that disposes while its worker hangs ends its disposal at the kind's expireInSeconds and fails the job", async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const clock = createClock(Date.now());
    const workers = new HeldWorkers();
    await using owner = await ownerOn(t, clock, folder.path, workers, {
      workers: 1,
      expireInSeconds: 7,
    });
    await using sending = await sender(owner.store, clock);
    await sending.jobs.send(queue, { input: { id: 'hung' } });
    await fetched(t, clock, workers, 'hung');

    const limit = (await fetchedAt(sending.jobs)) + 7_000;

    let disposed = false;
    const disposal = owner.dispose().finally(() => {
      disposed = true;
    });
    await runFor(clock, limit - 10 - clock.now);
    assert.equal(disposed, false);
    await runFor(clock, 20);
    await untilAborted(disposal, t.signal);

    assert.equal(workers.killed('hung'), true);
    const [job] = await sending.jobs.findJobs(queue);
    assert.deepEqual(
      [job?.state, job?.output],
      ['failed', { name: 'Error', message: 'handler execution exceeded 7s' }],
    );
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
  const owner = new PoolWorkers({
    kind: new WorkerKind<{ id: string }, { id: string }>({
      name: 'echo',
      revision: 1,
      policy: 'standard',
      retryLimit: 0,
      expireInSeconds: settings.expireInSeconds,
    }),
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
 * Moves the fake clock past the owner's backstop, which fetches the jobs that
 * wait, then waits in real time, with the clock still, until each job of `ids`
 * runs on a worker: a worker's start and the election take real I/O.
 */
async function fetched(
  t: TestContext,
  clock: FakeClock,
  workers: HeldWorkers,
  ...ids: string[]
): Promise<void> {
  await runFor(clock, 1_000);
  await waitFor(
    () => {
      for (const id of ids) assert.ok(workers.running(id), `job ${id} runs`);
    },
    { signal: t.signal, interval: 5 },
  );
}

/** The fake-clock time at which the owner fetched the one job of the queue. */
async function fetchedAt(jobs: SqliteJobQueue): Promise<number> {
  const [job] = await jobs.findJobs(queue);
  assert.ok(job?.startedOn, 'the job was fetched');
  return job.startedOn.getTime();
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
  options: {
    size: Sizing;
    startup: Startup;
    eviction: Eviction;
    create: () => Worker<string, string>;
  },
): PoolWorkers<string, string> {
  return new PoolWorkers({
    kind: new WorkerKind<string, string>({
      name: 'echo',
      revision: 1,
      policy: 'standard',
      retryLimit: 0,
      expireInSeconds: 60,
    }),
    store,
    clock: globalThis,
    ...options,
  });
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

/**
 * Sends one job of the "echo" kind, and resolves with its output once the
 * owner completes it, or rejects with its failure, as `Pool.run` will
 * (ADR 0019).
 */
async function ran(
  t: TestContext,
  jobs: SqliteJobQueue,
  input: string,
): Promise<string> {
  return outputOf(t, jobs, await sent(jobs, input));
}

/** Sends one job of the "echo" kind in the pool's envelope, and gives its id. */
async function sent(jobs: SqliteJobQueue, input: string): Promise<string> {
  const id = await jobs.send(queue, { input });
  assert.ok(id, 'the store took the job');
  return id;
}

/** Resolves with the output of the job once it completes, or rejects with its failure. */
async function outputOf(
  t: TestContext,
  jobs: SqliteJobQueue,
  id: string,
): Promise<string> {
  const job = await waitFor(
    async () => {
      const [found] = await jobs.findJobs(queue, { id });
      assert.ok(found, 'the store keeps the job');
      assert.match(found.state, /^(completed|failed)$/);
      return found;
    },
    { signal: t.signal, interval: 10 },
  );
  const { output } = job;
  assert.ok(typeof output === 'object' && output !== null);
  if (job.state === 'failed') {
    assert.ok('message' in output && 'name' in output);
    throw Object.assign(new Error(String(output.message)), {
      name: String(output.name),
    });
  }
  assert.ok('output' in output && typeof output.output === 'string');
  return output.output;
}

/** The input in the pool's envelope of a job's data. */
function inputOf(data: unknown): { id: string } {
  assert.ok(typeof data === 'object' && data !== null && 'input' in data);
  const { input } = data;
  assert.ok(typeof input === 'object' && input !== null && 'id' in input);
  assert.equal(typeof input.id, 'string');
  return { id: String(input.id) };
}
