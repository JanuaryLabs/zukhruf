import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { Latch } from '@zukhruf/async';
import { SqliteJobQueue } from '@zukhruf/sqlite-queue';
import { settleWithin } from '@zukhruf/testing/async';
import { TemporaryFiles } from '@zukhruf/testing/fs';
import { describe, test } from '@zukhruf/testing/node';

// The longest wait for a fact that should hold at once; it bounds a broken
// run and asserts no speed.
const factTimeout = 10_000;

// The queue of the kind that each host builds: "echo", revision 1.
const queue = 'echo.r1';

// A host: a program that builds PoolWorkers of the "echo" kind on the store
// of argv[1], with the settings of argv[2], and reports to the test over IPC.
// Its workers live in the host: run reports the job and answers with the
// host's pid after input.ms, throws input.fail, and never answers in the host
// whose pid is input.hangIn. "dispose" disposes the PoolWorkers; a lingering
// host then stays alive.
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
  async close() { this.#exit.resolve(); }
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
    label: string,
    timeout = factTimeout,
  ): Promise<Report> {
    const found = this.reports.find(match);
    if (found) return found;
    const arrived = Promise.withResolvers<Report>();
    const listener = (report: Report) => {
      if (match(report)) arrived.resolve(report);
    };
    this.#child.on('message', listener);
    try {
      return await settleWithin(arrived.promise, label, timeout);
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

/** The test's own connection to the store, as a host that only sends. */
async function sender(store: string) {
  const jobs = await new SqliteJobQueue({
    path: store,
    supervise: false,
    schedule: false,
  }).start();
  return { jobs, [Symbol.asyncDispose]: () => jobs.stop() };
}

const owns = (report: Report) => 'created' in report;
const constructed = (report: Report) => 'constructed' in report;

describe('PoolWorkers', { concurrency: true }, () => {
  test('a host whose store is a postgres:// address is refused and opens no file', async () => {
    await using folder = await new TemporaryFiles().directory('pool-');
    await using refused = new Host(
      'postgres://localhost/pool',
      { workers: 1, retryLimit: 0 },
      folder.path,
    );

    const report = await refused.report(
      (report) => 'refused' in report,
      'the refusal',
    );

    assert.deepEqual(report, { refused: 'TypeError' });
    assert.equal(await refused.closed(), 1);
    assert.deepEqual(await readdir(folder.path, { recursive: true }), []);
  });

  test('of two hosts on one store, only the owner starts workers and runs the jobs', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    await using owner = new Host(store, { workers: 2, retryLimit: 0 });
    await owner.report(owns, 'the owner');
    await using standby = new Host(store, { workers: 2, retryLimit: 0 });
    await standby.report(constructed, 'the standby');
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

  test("the owner creates the kind's queue with the kind's rules and a heartbeat of 10 s", async () => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    await using owner = new Host(store, {
      workers: 1,
      retryLimit: 3,
      policy: 'exclusive',
    });
    await owner.report(owns, 'the owner');
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
    await using owner = new Host(store, { workers: 2, retryLimit: 0 });
    await owner.report(owns, 'the owner');
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
    await using owner = new Host(store, { workers: 2, retryLimit: 0 });
    await owner.report(owns, 'the owner');
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

    const jobs = await settled(t, sending.jobs, 5, 30_000);
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
    await using owner = new Host(store, { workers: 1, retryLimit: 1 });
    await owner.report(owns, 'the owner');
    await using standby = new Host(store, { workers: 1, retryLimit: 1 });
    await standby.report(constructed, 'the standby');
    await using sending = await sender(store);
    await sending.jobs.send(queue, {
      input: { id: 'held', hangIn: owner.pid },
    });
    await owner.report((report) => 'started' in report, 'the start');

    owner.kill();
    await owner.closed();

    // The job comes back by its heartbeat of 10 s, found by a supervise and
    // monitor pass each second: the defaults of 60 s miss this bound.
    const [job] = await settled(t, sending.jobs, 1, 30_000);
    assert.deepEqual(
      [job?.state, job?.output],
      ['completed', { output: { host: standby.pid, id: 'held' } }],
    );
  });

  test('an owner that disposes finishes its running job, then resigns while its process lives', async (t) => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    await using owner = new Host(store, {
      workers: 1,
      retryLimit: 0,
      linger: true,
    });
    await owner.report(owns, 'the owner');
    await using standby = new Host(store, { workers: 1, retryLimit: 0 });
    await standby.report(constructed, 'the standby');
    await using sending = await sender(store);
    await sending.jobs.send(queue, { input: { id: 'running', ms: 1_000 } });
    await owner.report((report) => 'started' in report, 'the start');

    owner.send('dispose');
    await owner.report((report) => 'disposed' in report, 'the disposal');
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

  test('a host that disposes its PoolWorkers exits by itself', async () => {
    await using folder = await new TemporaryFiles().directory('pool-');
    const store = join(folder.path, 'store.sqlite');
    await using owner = new Host(store, { workers: 1, retryLimit: 0 });
    await owner.report(owns, 'the owner');

    owner.send('dispose');

    assert.equal(
      await settleWithin(owner.closed(), 'the exit', factTimeout),
      0,
    );
  });
});

/** Waits until the store has `count` jobs of the queue, each settled. */
function settled(
  t: TestContext,
  jobs: SqliteJobQueue,
  count: number,
  timeout = factTimeout,
) {
  return t.waitFor(
    async () => {
      const found = await jobs.findJobs(queue);
      assert.equal(found.length, count);
      for (const job of found) assert.match(job.state, /^(completed|failed)$/);
      return found;
    },
    { interval: 20, timeout },
  );
}

/** The input in the pool's envelope of a job's data. */
function inputOf(data: unknown): { id: string } {
  assert.ok(typeof data === 'object' && data !== null && 'input' in data);
  const { input } = data;
  assert.ok(typeof input === 'object' && input !== null && 'id' in input);
  assert.equal(typeof input.id, 'string');
  return { id: String(input.id) };
}
