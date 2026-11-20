# @zukhruf/pool

Lends long-lived workers to jobs, one job for each worker at a time. A worker is costly to start: a native helper that loads a model, or a command-line agent that keeps a session. The pool starts workers, lends them, replaces a worker that exits, and stops all of them when you dispose it. You choose three things from standard classes: when the workers start (a startup), how many run (a sizing), and when an idle worker closes (an eviction).

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @zukhruf/pool
```

```ts
import { Fixed, NoEviction, Parallel, Pool, type Worker } from '@zukhruf/pool';

class Upper implements Worker<string, string> {
  readonly #exit = Promise.withResolvers<void>();
  async run(input: string): Promise<string> {
    return input.toUpperCase();
  }
  exited(): Promise<void> {
    return this.#exit.promise;
  }
  kill(): void {
    this.#exit.resolve();
  }
  async close(): Promise<void> {
    await this.#exit.promise;
  }
}

await using pool = new Pool({
  size: new Fixed(2),
  startup: new Parallel(),
  eviction: new NoEviction(),
  clock: globalThis,
  create: () => new Upper(),
});
const words = await Promise.all(
  ['one', 'two', 'three'].map((word) => pool.use((worker) => worker.run(word))),
);
console.log(words, pool.stats);
// [ 'ONE', 'TWO', 'THREE' ] { starting: 0, idle: 2, lent: 0, waiting: 0 }
```

The pool starts two workers and lends them to three jobs, one job for each worker at a time. After the jobs, both workers are idle. The disposal at the end of the program stops them.

## Lend a worker to a job

```ts
import { Fixed, IdleTimeout, Parallel, Pool } from '@zukhruf/pool';

await using pool = new Pool({
  size: new Fixed(2),
  startup: new Parallel(),
  eviction: new IdleTimeout({ after: 300_000 }),
  clock: globalThis,
  create: () => new VisionWorker('/path/to/vision-worker'),
});
const text = await pool.use((worker) => worker.run('/tmp/receipt.png'));
```

A worker gives `run(input)`, `exited()`, `kill()`, `close()`, and optionally `ready()`. `run` does one job and resolves with its output ([ADR 0012](./docs/adr/0012-a-job-is-data-and-the-worker-kind-runs-it.md)). A `Coprocess` of `@zukhruf/coprocess` has all of them except `run`, so a worker class keeps the `Coprocess` and gives its `request` as `run`.

A job takes an idle worker first. When no worker is idle, the job takes a worker that starts. Only when no worker starts does the job start a new worker. Of the idle workers, a job takes the one in the lowest slot. Thus jobs one at a time use one worker, and the other idle workers stay idle until their eviction lets them go.

When a signal aborts a job that runs, the pool kills its worker. When a signal aborts a job whose worker still warms up, the warm-up continues for the next job.

The pool waits for `ready()` with no time limit. Thus, if the warm-up of a worker can wait forever, the worker sets its own time limit, and `ready()` rejects when that limit ends. The pool then kills and closes the worker, and the job that waits for it fails. An eager startup starts a worker in that slot again after a back-off (see [Replace a worker that exits](#replace-a-worker-that-exits)). With `OnDemand`, the next job starts a new worker.

## Choose when the workers start

| Startup        | Starts                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OnDemand`     | a worker only when a job needs one                                                                                                                         |
| `Parallel`     | every worker when you build the pool, all together                                                                                                         |
| `OrderedReady` | every worker when you build the pool, one after the other, as Kubernetes starts an `OrderedReady` StatefulSet                                              |
| `LeaderFirst`  | the first worker alone, and the others together when it is ready. Use it when the first worker fills a cache that the others read, such as compiled models |

## Choose how many workers run

| Sizing                                        | Runs                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Fixed(n)`                                    | n workers                                                                                                           |
| `Resources({ memoryPerWorker, computer })`    | one for each CPU, while each finds its memory free                                                                  |
| `HillClimbing({ memoryPerWorker, computer })` | two first, then as many as add at least a tenth more jobs a second each (as the .NET thread pool)                   |
| `Gradient({ memoryPerWorker, computer })`     | two first, then as many as keep a job at most half again the time it takes with two (as Netflix concurrency-limits) |

The two sizings that learn take steps for as long as the pool runs. A step measures three windows of at least 20 jobs and 2 seconds: at the size it has, at the size it tries, and at the size it has again. A sizing measures only while jobs wait and every worker is ready.

- A step tries one more worker, or fewer: `HillClimbing` one fewer, `Gradient` two. A step with fewer keeps every worker alive, so it costs no warm-up.
- The sizing keeps one more worker as soon as one step shows that it pays. It lets a worker go only after two steps in a row show that the worker does not pay.
- After a step that changes nothing, the sizing pauses: one window first, then twice as long after each such step, up to 16 windows. The length is random, so pools in other processes do not step at the same moments.
- After each window, the sizing reads the free memory again. When its workers do not fit, it runs fewer at once. It never runs more than the capacity when the pool was built.

See [ADR 0002](./docs/adr/0002-a-sizing-that-learns-compares-one-more-worker-between-two-windows.md) and [ADR 0007](./docs/adr/0007-a-sizing-that-learns-keeps-learning-in-steps-both-ways-and-pauses-between-steps-that-change-nothing.md).

## Give the sizing the computer

`Resources`, `HillClimbing` and `Gradient` find the capacity: the most workers the computer can give. They read the CPU count and the free memory from the `computer` that you give. A sizing that learns reads the free memory again after each window. Give the two functions of Node in production:

```ts
import { availableParallelism } from 'node:os';

import { HillClimbing } from '@zukhruf/pool';

const { availableMemory } = process;
const size = new HillClimbing({
  memoryPerWorker: 2 * 1024 ** 3,
  computer: { availableParallelism, availableMemory },
});
```

A test gives a plain object, and changes what it returns to show other processes that take the memory:

```ts
let free = 8 * 1024 ** 3;
const computer = { availableParallelism: () => 4, availableMemory: () => free };
// ...
free = 2.5 * 1024 ** 3;
```

A host that runs several pools on one computer can give each pool a part of the memory, for example `availableMemory: () => process.availableMemory() / 2`. See [ADR 0009](./docs/adr/0009-a-sizing-reads-the-capacity-from-the-computer-that-the-caller-gives.md).

## Choose when idle workers close

| Eviction                 | Evicts                                                       |
| ------------------------ | ------------------------------------------------------------ |
| `NoEviction`             | no worker. Each idle worker stays until you dispose the pool |
| `IdleTimeout({ after })` | a worker that stays idle for `after` milliseconds            |

A job that takes the worker before `after` ends keeps it. When the job ends, a new `after` starts. `after` is a number of milliseconds above 0 and at most 2,147,483,647. Another value throws a `RangeError`, because Node runs a timer with a larger delay after 1 ms.

Mature pools give these idle times: the .NET thread pool 20 s, generic-pool 30 s, KEDA and the Kubernetes HPA 300 s before they scale down, and HikariCP 10 minutes. A worker that is costly to start, such as a helper that loads a model, needs a long time. A worker that holds much memory needs a short time.

The pool evicts only a worker in a slot that the sizing runs. A worker that the sizing keeps but does not run stays alive for the next step of the sizing ([ADR 0002](./docs/adr/0002-a-sizing-that-learns-compares-one-more-worker-between-two-windows.md)). The next job that needs an evicted slot starts a new worker. See [ADR 0006](./docs/adr/0006-the-pool-evicts-an-idle-worker-that-its-eviction-lets-go-and-lends-an-idle-worker-first.md).

## Read the stats

A host can ask the pool how its workers are, for example in a health check:

```ts
const { starting, idle, lent, waiting } = pool.stats;
const healthy = waiting === 0 || starting + idle + lent > 0;
```

| Count      | Is                                                                         |
| ---------- | -------------------------------------------------------------------------- |
| `starting` | the workers that start and are not ready yet                               |
| `idle`     | the ready workers that no job has                                          |
| `lent`     | the ready workers that a job has                                           |
| `waiting`  | the jobs that wait for a worker: in the queue, or for a worker that starts |

A worker that exited is in no count, and a slot whose worker the pool evicted is in no count. Thus a pool with an eviction can show zero in each count and be healthy: the next job starts a worker. Each read makes a new object, so the counts of one read agree with each other. See [ADR 0004](./docs/adr/0004-a-pool-reports-its-stats-as-one-snapshot-of-counts.md).

## Replace a worker that exits

A job that needs the slot of an exited worker starts a new worker. An eager startup also replaces an idle worker that exits. After an early exit (a worker that ran less than 10 minutes), the pool waits first: 1 s, then 2 s, 4 s, and so on up to 60 s for each early exit in a row. A worker that runs 10 minutes ends this back-off. A job does not wait for a back-off: its worker starts now. Kubernetes restarts a container in CrashLoopBackOff with the same rule. The pool does not count an evicted worker as an exit: it does not replace the worker and does not start a back-off. An evicted worker that ran 10 minutes ends the back-off too. See [ADR 0005](./docs/adr/0005-an-eager-pool-backs-off-before-it-replaces-a-worker-that-exited-early.md).

A worker whose warm-up fails is an early exit too. An eager startup starts that slot again after the back-off, also when a job started the worker, so the pool has warm workers again before the next job. See [ADR 0010](./docs/adr/0010-an-eager-pool-starts-a-worker-again-after-its-warm-up-fails.md).

## Run the pool on a clock

The pool measures the time of each job, waits before it replaces a worker that exited early, and gives the eviction the clock for its waits. All of these run on the `clock` that you give. Give `globalThis` in production. A test gives `createClock()` of `@sinonjs/fake-timers` and moves it with `await clock.tickAsync(ms)`, so a back-off of 60 seconds or a sizing window of 2 seconds takes no real time ([`@zukhruf/async`](../async/README.md#run-a-wait-on-a-clock)).

An eviction of your own gets the clock of the pool as the third argument of `idle(busy, evict, clock)`, so the pool and its eviction always run on one clock. See [ADR 0008](./docs/adr/0008-the-pool-measures-and-waits-on-the-clock-that-the-caller-gives.md).

## One pool for the computer

Design for review (backlog #3527). `WorkerKind`, `computerStore` and `PoolWorkers` are built. `PoolWorkers` touches each running job every 5 s. It kills the worker of a job at the kind's time limit, and when the store took the job back. It does not yet wake on the "new job" notification, and it has no `stats` and no `ready()` yet. `Pool` with `start`, `handle` and `run` is not built yet, and `use` stays until it is. The text above tells what the package does today. [ADR 0011](./docs/adr/0011-every-pool-is-a-pool-for-the-computer-and-one-owner-pulls-its-jobs-from-a-store-that-every-host-writes-to.md) to [ADR 0026](./docs/adr/0026-start-accepts-a-job-now-and-a-job-handle-reads-its-output-later-from-any-host.md) record the design. The tickets and the research named here are in the pool map, `.scratch/one-pool-for-the-computer/` at the workspace root, which git does not track.

Today each host builds its own pool, so several hosts on one computer run several full pools, and they compete for one Neural Engine (#2896, #3868). In the design, every pool is a pool for the computer. On each computer, one host owns the workers of a pool. Every host writes its jobs to one store, and only the owner takes them. A job is data, so it can go from one host to another. The pool for the computer replaces the pool of today: `use((worker) => …)` goes away.

The words of the design are in [CONTEXT.md](./CONTEXT.md), section "The pool for the computer".

### Define the worker kind

A worker kind names the pool and holds its job rules. Export it from a module with no native code, so a host that cannot run the worker program can import it too:

```ts
import { WorkerKind } from '@zukhruf/pool';

export const vision = new WorkerKind<{ path: string }, { text: string }>({
  name: 'vision',
  revision: 1, // raise it when run changes in a way that matters
  policy: 'exclusive', // identical inputs share one job
  retryLimit: 2,
  expireInSeconds: 120,
});
```

The rule names are pg-boss's queue options, with pg-boss's meaning. Each one is required. See [ADR 0014](./docs/adr/0014-pool-and-pool-workers-take-one-worker-kind.md).

### Send jobs, and offer workers

A host that can run the worker program sends jobs and offers its workers:

```ts
import { availableParallelism } from 'node:os';

import {
  HillClimbing,
  IdleTimeout,
  LeaderFirst,
  Pool,
  PoolWorkers,
  computerStore,
} from '@zukhruf/pool';

const store = computerStore(process.env);
const { availableMemory } = process;

await using ocr = new Pool({ kind: vision, store, clock: globalThis });
await using workers = new PoolWorkers({
  kind: vision,
  store,
  clock: globalThis,
  create: () => new VisionWorker('/path/to/vision-worker'),
  size: new HillClimbing({
    memoryPerWorker: 2 * 1024 ** 3,
    computer: { availableParallelism, availableMemory },
  }),
  startup: new LeaderFirst(),
  eviction: new IdleTimeout({ after: 300_000 }),
});

const { text } = await ocr.run({ path: '/tmp/receipt.png' }, { signal });
```

A host that answers at once starts the job, and reads its output later, from this host or another:

```ts
const { id } = await ocr.start({ path: '/tmp/receipt.png' });
// later, in any host with a Pool of the same kind
const { text } = await ocr.handle(id).result({ signal });
```

A host that cannot run the worker program only sends. To reach the workers of another computer, it gives a shared Postgres store:

```ts
await using ocr = new Pool({
  kind: vision,
  store: 'postgres://…',
  clock: globalThis,
});
```

A test gives a store of its own, so it never joins the user's pool:

```ts
await using scratch = await mkdtempDisposable(join(tmpdir(), 'pool-'));
const store = join(scratch.path, 'store.sqlite');
```

### The API

```ts
import type { WallClock } from '@zukhruf/async';

export class WorkerKind<Input, Output> {
  constructor(options: {
    name: string;
    revision: number;
    policy: 'standard' | 'exclusive';
    retryLimit: number;
    expireInSeconds: number;
  });
  readonly name: string;
  readonly revision: number;
  readonly policy: 'standard' | 'exclusive';
  readonly retryLimit: number;
  readonly expireInSeconds: number;
  /** The queue of this revision in the store: `<name>.r<revision>`. */
  readonly queue: string;
}

/** Sends jobs of one kind to the store, and waits for their outputs. */
export class Pool<Input, Output> implements AsyncDisposable {
  constructor(options: {
    kind: WorkerKind<Input, Output>;
    store: string;
    clock: WallClock;
  });
  /** Sends the job, and resolves when the store has it. */
  start(input: Input): Promise<JobHandle<Output>>;
  /** The handle of a job of this kind and revision that any host started. */
  handle(id: string): JobHandle<Output>;
  /** start, then result. The abort of signal cancels the job. */
  run(input: Input, options?: { signal?: AbortSignal }): Promise<Output>;
  /** The jobs of the kind in the store, the same from every host. */
  stats(): Promise<JobCounts>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Offers this host's workers. Owns them while this host leads. */
export class PoolWorkers<Input, Output> implements AsyncDisposable {
  constructor(options: {
    kind: WorkerKind<Input, Output>;
    store: string;
    clock: WallClock;
    create: () => Worker<Input, Output>;
    size: Sizing;
    startup: Startup;
    eviction: Eviction;
  });
  /** This host's slots: zero in each count while it does not own. */
  readonly stats: PoolStats;
  /** Resolves when this host owns and its startup workers are ready. */
  ready(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface Worker<Input, Output> {
  run(input: Input): Promise<Output>;
  ready?(): Promise<unknown>;
  exited(): Promise<unknown>;
  kill(): void;
  close(): Promise<void>;
}

/** A job in the store, by its id. */
export interface JobHandle<Output> {
  readonly id: string;
  /** Waits for the output. The abort of signal ends only this wait. */
  result(options?: { signal?: AbortSignal }): Promise<Output>;
  /** A leave for a shared job; a drop or a kill for any other job. */
  cancel(): Promise<void>;
}

export interface JobCounts {
  readonly waiting: number;
  readonly running: number;
}

/** The store of this computer, for the user of env: zukhruf-pool/store.sqlite in the user's state folder for process.platform. */
export function computerStore(env: Record<string, string | undefined>): string;

export class JobFailedError extends Error {
  readonly failure: { readonly name: string; readonly message: string };
}
export class JobCancelledError extends Error {}
export class JobNotFoundError extends Error {}
export class DeprecatedRevisionError extends Error {}
export class DisposedError extends Error {}
```

### The rules

- **One owner.** On each computer, one host owns the workers of a pool. `PoolWorkers` campaigns in a `SqliteElection` of [`@zukhruf/election`](../election/README.md), with the claim files in the folder of the store. The other hosts with a `PoolWorkers` are standbys ([ADR 0011](./docs/adr/0011-every-pool-is-a-pool-for-the-computer-and-one-owner-pulls-its-jobs-from-a-store-that-every-host-writes-to.md)).
- **The two roles.** `Pool` sends. `PoolWorkers` offers workers and has no `run`. They meet only through the worker kind and the store, as BullMQ's `Queue` and `Worker` meet through the queue name ([ADR 0013](./docs/adr/0013-pool-sends-jobs-and-pool-workers-offers-the-workers-of-its-host.md)).
- **A job is data.** The input and the output are JSON. A file goes by reference: a path on one computer. The code of a job is the worker's `run` ([ADR 0012](./docs/adr/0012-a-job-is-data-and-the-worker-kind-runs-it.md)).
- **The store** is a required address. A path of a SQLite file is the store of one computer, through [`@zukhruf/sqlite-queue`](../sqlite/queue/README.md). A `postgres://` address joins computers, through pg-boss. `computerStore(env)` gives `zukhruf-pool/store.sqlite` in the user's state folder: `$HOME/Library/Application Support` on macOS, `$XDG_STATE_HOME` (or `$HOME/.local/state`) on Linux, `%LOCALAPPDATA%` on Windows. It reads `process.platform`, and takes `env` as its input, as Go's `os.UserConfigDir` reads `runtime.GOOS`. Every `Pool` and `PoolWorkers` opens the store and creates the queue of its revision ([ADR 0015](./docs/adr/0015-the-store-is-a-required-input-and-computer-store-gives-the-store-of-the-computer.md)).
- **The clock.** The store keeps the wall time of each job, so `Pool` and `PoolWorkers` take a `WallClock` of [`@zukhruf/async`](../async/README.md): `globalThis` in production. The pool gives `@zukhruf/sqlite-queue` pg-boss's clock, made from it.
- **A failure of the store** ends the host's campaign or ownership: a standby stops its campaign, and an owner stops fetching, finishes its running jobs, resigns and then closes its workers, and the disposal of `PoolWorkers` rejects with the failure. The jobs stay in the store for the next owner.
- **The cap.** The owner's sizing caps the jobs of its computer. The store keeps no count of running jobs. A new owner starts its sizing fresh ([ADR 0016](./docs/adr/0016-the-owners-sizing-caps-the-jobs-of-its-computer.md)).
- **The owner asks, then takes.** It calls `fetch(name, { batchSize: free })` on the queue of its revision for its free workers, settles each job with `complete` or `fail` by its attempt, and calls `touch` for each running job every 5 s on a heartbeat of 10 s. It fetches when a worker becomes free, at a "new job" wake, and at the backstop ([ADR 0017](./docs/adr/0017-the-owner-asks-then-takes-as-many-jobs-as-it-has-free-workers.md)).
- **News travels by push.** Two channels for each pool: "a new job", with the revision, which the owner hears, and "an output", with the job id, which each waiting `Pool` hears. On one computer they go through [`@zukhruf/sqlite-notify`](../sqlite/notify/README.md), across computers through Postgres `LISTEN` / `NOTIFY`. The store is the truth, and a wake only says "read the store". A backstop each second on one computer finds a lost wake, and a job that the store's monitor failed ([ADR 0018](./docs/adr/0018-news-travels-by-push-through-the-notify-of-the-store-with-a-backstop.md)).
- **`run` waits** for the output. The kind's `retryLimit` decides how often a job runs again, its `expireInSeconds` limits one run, and the caller's `signal` limits only the caller's wait. With no owner anywhere, the job waits in the store. `run` is `start`, then `result` ([ADR 0019](./docs/adr/0019-run-waits-and-a-failed-job-rejects-with-the-pools-error.md)).
- **Accept now, read later.** `start(input)` resolves with a `JobHandle { id, result({ signal }), cancel() }`, and `handle(id)` gives the handle of a job from any host, as Temporal's `start` and `getHandle`. The job outlives the host that started it. A handle reads the job until the store's retention ends: 7 days after the job settled ([ADR 0026](./docs/adr/0026-start-accepts-a-job-now-and-a-job-handle-reads-its-output-later-from-any-host.md)).
- **A cancel.** The caller's abort of a shared job is a leave: its `run` rejects, and the job runs to its end for the other callers. The abort of any other job drops it when it waits, and kills its worker when it runs. `cancel()` of a handle does the same ([ADR 0020](./docs/adr/0020-a-cancel-of-a-shared-job-is-a-leave-and-of-any-other-job-a-drop-or-a-kill.md); Ezz, 2026-11-14: "we need to follow top perfoerms").
- **A caller that is gone.** Each job of a `run` carries its caller's address: a pipe of [`@zukhruf/pipes`](../pipes/README.md) that the waiting `Pool` serves. A job of `start` carries none. The owner connects to it before it starts the job, and keeps the connection while the job runs. A refused connect or a close is a cancel of that caller ([ADR 0021](./docs/adr/0021-a-caller-whose-host-is-gone-cancels-its-jobs-and-the-owner-learns-it-from-a-closed-connection.md)).
- **Revisions.** Each revision has its own queue, `<name>.r<revision>`, so an older owner never fetches a job of a newer revision, as Temporal routes a task by its build id. An owner refuses a job of an older revision with `DeprecatedRevisionError`. An owner that hears a wake of a newer revision finishes its running jobs and resigns ([ADR 0022](./docs/adr/0022-the-newest-revision-takes-over-and-an-owner-refuses-a-job-of-an-older-revision.md)).
- **Ownership moves** only by the owner's own act or its end. A standby starts no workers until it owns. A clean owner finishes its jobs and resigns. The jobs of a dead owner come back by their heartbeat. `ready()` never resolves on a standby ([ADR 0023](./docs/adr/0023-ownership-moves-only-by-the-owners-own-act-or-its-end-and-a-standby-stays-cold.md)).
- **A hung owner** is ended by the election: a standby that hears no heartbeat on the leader's pipe for 15 s kills the leader's process. A late `complete` of the old owner affects 0 rows ([ADR 0024](./docs/adr/0024-a-hung-owner-is-ended-by-the-election-and-its-late-acts-are-fenced.md)).
- **Many computers** share one Postgres store, and each computer elects its own owner. It is built only when a second computer is real ([ADR 0025](./docs/adr/0025-many-computers-share-one-postgres-store-and-each-computer-keeps-its-own-owner.md)).

### Errors

| Error                     | When `run` or `result` rejects with it                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JobFailedError`          | The job failed its last run. `failure` has the name and the message that the owner stored, for example the worker's error or "handler execution exceeded 60s". |
| `DeprecatedRevisionError` | The owner runs a newer revision of the kind, and refused this job. Update the host.                                                                            |
| `JobCancelledError`       | The job was cancelled, by `cancel()` of a handle or by the abort of a `run`.                                                                                   |
| `JobNotFoundError`        | The store has no job with the id: it was deleted after the retention, it belongs to another revision, or it never existed.                                     |
| `DisposedError`           | The host disposed its `Pool` while the `run` or the `result` waited.                                                                                           |
| The reason of `signal`    | The caller's signal aborted.                                                                                                                                   |

### The gaps that come first

Each gap that the design found goes to the package that must have it, and is built before the pool (Ezz, 2026-11-13: "Anything that is missing then goes to the appropriate package").

| Gap                                                                | Home                     | State                                               |
| ------------------------------------------------------------------ | ------------------------ | --------------------------------------------------- |
| The socket address of a program of one computer                    | `@zukhruf/pipes`         | Built (#2496)                                       |
| A claim that is not atomic across connections                      | `@zukhruf/sqlite-queue`  | Built (#3700)                                       |
| pg-boss's `fetch` and `complete`                                   | `@zukhruf/sqlite-queue`  | Built (#4313)                                       |
| pg-boss's `touch`                                                  | `@zukhruf/sqlite-queue`  | Built (#4370)                                       |
| No `LISTEN` / `NOTIFY` on a SQLite file                            | `@zukhruf/sqlite-notify` | Built (#4333)                                       |
| `useListenNotify` across instances on one file                     | `@zukhruf/sqlite-queue`  | Built (#4334). The pool does not use it (ADR 0018). |
| A standby that polls, and a hung leader that nobody ends           | `@zukhruf/election`      | Built (#4371)                                       |
| An older release that rebuilds a newer file                        | `@zukhruf/sqlite-queue`  | Built (#4369)                                       |
| A count of the jobs of a queue by state, pg-boss's `getQueueStats` | `@zukhruf/sqlite-queue`  | Not built. `pool.stats()` needs it (#2888).         |
| A job from `findJobs` carries a `signal`, and pg-boss's does not   | `@zukhruf/sqlite-queue`  | Fixed (#4331)                                       |
| A write that waits more than the busy timeout of 5 s fails         | `@zukhruf/sqlite-queue`  | Open risk (#4355)                                   |
| A synced commit on macOS is a plain `fsync`                        | `@zukhruf/sqlite-queue`  | Open risk (#4351)                                   |
| Nothing ran on Windows                                             | each package             | Deferred (#4340)                                    |

### Decided

The three open features, and the three items that the records did not decide, were decided on 2026-11-16 (backlog #3527, "DECISIONS 2026-11-16").

1. **Accept a job now, and read its output later: yes, in Temporal's shape.** Ezz: "learn from memoroies what is my style and pick". His recorded rule for a standard package: put a capability in or out for a reason of its domain, never because no consumer needs it yet. Every leading job system has it: Temporal's `start` and `getHandle`, Celery's `AsyncResult`, BullMQ's `Job.fromId` and `waitUntilFinished`, pg-boss's `send` id and `findJobs`, and Azure Asynchronous Request-Reply. Temporal's shape maps one-to-one onto pg-boss ([ADR 0026](./docs/adr/0026-start-accepts-a-job-now-and-a-job-handle-reads-its-output-later-from-any-host.md)).
2. **A result cache: no cache in the pool.** Ezz: "No cache in the pool (Recommended)". A host that wants one keeps it above the pool, keyed by content, as Bazel keeps its action cache above its workers.
3. **Cancel a running job with no kill: kill only for now.** Ezz: "Kill only for now (Recommended)". A cancel signal on the worker's `run` comes later, as Bazel sends `cancel: true` to a worker that declares `supports-worker-cancellation`. The trigger is a costly kind that cannot be shared, with a worker that can cancel ([ADR 0020](./docs/adr/0020-a-cancel-of-a-shared-job-is-a-leave-and-of-any-other-job-a-drop-or-a-kill.md)).

Decided by the leaders (Ezz: "I trust your recommendation ... follow the top performers"):

4. **The address on each job** is a pipe of `@zukhruf/pipes` that each waiting `Pool` serves, as gRPC learns of a gone client from the caller's own stream. `@zukhruf/sqlite-notify` does not change ([ADR 0021](./docs/adr/0021-a-caller-whose-host-is-gone-cancels-its-jobs-and-the-owner-learns-it-from-a-closed-connection.md)).
5. **A queue for each worker revision**, so an older owner never fetches a job of a newer revision, as Temporal worker versioning routes a task by its build id and Amazon SWF by the version ([ADR 0022](./docs/adr/0022-the-newest-revision-takes-over-and-an-owner-refuses-a-job-of-an-older-revision.md)).
6. **`computerStore(env)` reads `process.platform`**, and takes `env` as its input, as Go's `os.UserConfigDir` reads `runtime.GOOS` ([ADR 0015](./docs/adr/0015-the-store-is-a-required-input-and-computer-store-gives-the-store-of-the-computer.md)).

### Moving the hosts

A plan, not code. The hosts that move are elt and context-compiler (map, Revision 2026-11-13). trashbot is not in use, stays on `@zukhruf/pool` 0.6.15, and does not move.

1. **zukhruf, before the pool**: Ezz reviews ADR 0011 to ADR 0026. `@zukhruf/sqlite-queue` gets pg-boss's `getQueueStats(name)` with its parity tests, because `pool.stats()` needs it (#2888). #4331 is fixed.
2. **zukhruf, the pool**: `WorkerKind`, `Pool` with `start`, `handle` and `run`, `PoolWorkers` and `computerStore`, with tests of several real hosts on one computer: each test with its own store file, real worker processes and the real clock. `use` and its tests go. The recipes change to the new API, and this section becomes the README. Then a release.
3. **elt**: a `vision` kind (`exclusive`, with retries) and a `transcription` kind (`standard`) in modules with no native code. The worker classes implement `run`. `ImageFormat` takes a `Pool` of the `vision` kind, in place of `Pool<VisionWorker>` (`image-format.ts:56`). `local-transcription-model.ts:85` gives the path of its wav to `run`.
4. **context-compiler**: the server (`apps/server/src/startup.ts:11`) and the CLI (`apps/cli/src/parsing.ts:61`) build a `Pool` and a `PoolWorkers` of the `vision` kind with `computerStore(process.env)`. `packages/connectors/connector/src/transcription.ts:96` does the same for transcription. Each host disposes them at a termination signal, through `@zukhruf/shutdown`.
5. **elt and context-compiler** move to the new release of `@zukhruf` in one step, and release together.
6. **A measure**: the contention benchmark of 2026-11-02 runs again with two hosts on one store. One owner's sizing then caps the computer.

Many computers come after map ticket 14, when a second computer is real.

## Errors

These are the errors that the package throws today. The errors of the design are in the section "One pool for the computer".

| Error                    | When                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RangeError`             | `new WorkerKind` gets a name whose channel `<name>.new-job` has 64 bytes or more ([src/worker-kind.test.ts](./src/worker-kind.test.ts)).                                                                                                                                                                                |
| `RangeError`             | `new IdleTimeout({ after })` gets an `after` that is not above 0 and at most 2,147,483,647 ([src/pool.test.ts](./src/pool.test.ts)).                                                                                                                                                                                    |
| `TypeError`              | `new PoolWorkers` gets a `postgres://` store. Only the store of one computer, the path of a SQLite file, is built ([src/pool-workers.test.ts](./src/pool-workers.test.ts)).                                                                                                                                             |
| `Error`                  | `computerStore(env)` finds no `$HOME` on macOS, no `$HOME` and no `$XDG_STATE_HOME` on Linux, or no `%LOCALAPPDATA%` on Windows ([src/computer-store.test.ts](./src/computer-store.test.ts)).                                                                                                                           |
| The failure of the store | The disposal of `PoolWorkers` rejects with the first failure of its store, for example an `expireInSeconds` that the store refuses ([src/pool-workers.test.ts](./src/pool-workers.test.ts)).                                                                                                                            |
| `signal.reason`          | `pool.use` rejects with it when its signal aborts.                                                                                                                                                                                                                                                                      |
| `AbortError`             | `pool.use` rejects with it when you dispose the pool, also for a job that waits ([src/pool.test.ts](./src/pool.test.ts)).                                                                                                                                                                                               |
| The error of the job     | `pool.use` rejects with what `job` throws, for example the error of a worker that exited while the job ran.                                                                                                                                                                                                             |
| The error of the warm-up | `pool.ready()` rejects with it when a worker that the startup starts with the pool fails its `ready()`. When you dispose the pool while such a worker warms up, the pool kills the worker, and `pool.ready()` rejects with the reason that the `ready()` of that worker gives ([src/pool.test.ts](./src/pool.test.ts)). |

## API

The exports of today. The section "One pool for the computer" gives the design, which is not all built.

```ts
import type { Clock, WallClock } from '@zukhruf/async';

class Pool<T extends Worker<never, unknown>> implements AsyncDisposable {
  constructor(options: {
    size: Sizing;
    startup: Startup;
    eviction: Eviction;
    create: () => T;
    clock: Clock; // globalThis in production, a fake clock in a test
  });
  ready(): Promise<void>; // the workers that the startup starts with the pool are ready
  get stats(): PoolStats; // a new snapshot at each read
  use<R>(job: (worker: T) => Promise<R>, signal?: AbortSignal): Promise<R>;
  [Symbol.asyncDispose](): Promise<void>; // stops every worker
}

class PoolWorkers<Input, Output> implements AsyncDisposable {
  constructor(options: {
    kind: WorkerKind<Input, Output>;
    store: string; // the path of the store's SQLite file, such as computerStore(process.env)
    clock: WallClock;
    create: () => Worker<Input, Output>;
    size: Sizing;
    startup: Startup;
    eviction: Eviction;
  }); // TypeError: a postgres:// store
  [Symbol.asyncDispose](): Promise<void>; // rejects with the failure of the store
}

class WorkerKind<Input, Output> {
  constructor(options: {
    name: string;
    revision: number;
    policy: 'standard' | 'exclusive';
    retryLimit: number;
    expireInSeconds: number;
  }); // RangeError: "<name>.new-job" has 64 bytes or more
  readonly name: string;
  readonly revision: number;
  readonly policy: 'standard' | 'exclusive';
  readonly retryLimit: number;
  readonly expireInSeconds: number;
  readonly queue: string; // `<name>.r<revision>`
}

function computerStore(env: Record<string, string | undefined>): string;

interface Worker<Input, Output> {
  run(input: Input): Promise<Output>;
  ready?(): Promise<unknown>;
  exited(): Promise<unknown>;
  kill(): void;
  close(): Promise<void>;
}

interface Sizing {
  readonly ceiling: number; // the most workers it may run, decided when the pool is built
  readonly current: number; // the workers it runs now
  readonly kept: number; // the workers it keeps alive, at least current
  record(sample: Sample): void;
}

interface Sample {
  readonly started: number;
  readonly finished: number;
  readonly measurable: boolean;
}

interface Startup {
  readonly eager: boolean;
  turn(settled: Promise<void>): Promise<void>;
}

interface Eviction {
  idle(busy: AbortSignal, evict: () => void, clock: Clock): void;
}

interface Computer {
  availableParallelism(): number;
  availableMemory(): number;
}

interface PoolStats {
  readonly starting: number;
  readonly idle: number;
  readonly lent: number;
  readonly waiting: number;
}

class Fixed implements Sizing {
  constructor(workers: number);
}
class Resources implements Sizing {
  constructor(options: { memoryPerWorker: number; computer: Computer });
}
class HillClimbing implements Sizing {
  constructor(options: { memoryPerWorker: number; computer: Computer });
}
class Gradient implements Sizing {
  constructor(options: { memoryPerWorker: number; computer: Computer });
}

class OnDemand implements Startup {}
class Parallel implements Startup {}
class OrderedReady implements Startup {}
class LeaderFirst implements Startup {}

class NoEviction implements Eviction {}
class IdleTimeout implements Eviction {
  constructor(options: { after: number }); // RangeError: unless 0 < after <= 2147483647
}
```

`HillClimbing` and `Gradient` extend a class that the package does not export ([src/climbing.ts](./src/climbing.ts)).

## Recipes

1. [Let the pool find how many workers pay](./docs/recipes/find-how-many-workers-pay.md)
2. [Warm a model once, then start the other workers](./docs/recipes/warm-a-model-once.md)
3. [Hold workers only while there is work](./docs/recipes/hold-workers-only-while-there-is-work.md)
4. [Test a pool on the real path](./docs/recipes/test-a-pool-on-the-real-path.md)

## Decisions

- [ADR 0001](./docs/adr/0001-startups-and-sizings-are-classes-that-a-caller-chooses.md): startups and sizings are classes that a caller chooses.
- [ADR 0002](./docs/adr/0002-a-sizing-that-learns-compares-one-more-worker-between-two-windows.md): a sizing that learns compares one more worker between two windows.
- [ADR 0003](./docs/adr/0003-the-pool-learns-that-a-worker-ended-from-its-exit.md): the pool learns that a worker ended from its exit.
- [ADR 0004](./docs/adr/0004-a-pool-reports-its-stats-as-one-snapshot-of-counts.md): a pool reports its stats as one snapshot of counts.
- [ADR 0005](./docs/adr/0005-an-eager-pool-backs-off-before-it-replaces-a-worker-that-exited-early.md): an eager pool backs off before it replaces a worker that exited early.
- [ADR 0006](./docs/adr/0006-the-pool-evicts-an-idle-worker-that-its-eviction-lets-go-and-lends-an-idle-worker-first.md): the pool evicts an idle worker that its eviction lets go, and lends an idle worker first.
- [ADR 0007](./docs/adr/0007-a-sizing-that-learns-keeps-learning-in-steps-both-ways-and-pauses-between-steps-that-change-nothing.md): a sizing that learns keeps learning in steps both ways, and pauses between steps that change nothing.
- [ADR 0008](./docs/adr/0008-the-pool-measures-and-waits-on-the-clock-that-the-caller-gives.md): the pool measures and waits on the clock that the caller gives.
- [ADR 0009](./docs/adr/0009-a-sizing-reads-the-capacity-from-the-computer-that-the-caller-gives.md): a sizing reads the capacity from the computer that the caller gives.
- [ADR 0010](./docs/adr/0010-an-eager-pool-starts-a-worker-again-after-its-warm-up-fails.md): an eager pool starts a worker again after its warm-up fails.
- [ADR 0011](./docs/adr/0011-every-pool-is-a-pool-for-the-computer-and-one-owner-pulls-its-jobs-from-a-store-that-every-host-writes-to.md): every pool is a pool for the computer, and one owner pulls its jobs from a store that every host writes to (proposed).
- [ADR 0012](./docs/adr/0012-a-job-is-data-and-the-worker-kind-runs-it.md): a job is data, and the worker kind runs it (proposed).
- [ADR 0013](./docs/adr/0013-pool-sends-jobs-and-pool-workers-offers-the-workers-of-its-host.md): `Pool` sends jobs, and `PoolWorkers` offers the workers of its host (proposed).
- [ADR 0014](./docs/adr/0014-pool-and-pool-workers-take-one-worker-kind.md): `Pool` and `PoolWorkers` take one worker kind (proposed).
- [ADR 0015](./docs/adr/0015-the-store-is-a-required-input-and-computer-store-gives-the-store-of-the-computer.md): the store is a required input, and `computerStore` gives the store of the computer (proposed).
- [ADR 0016](./docs/adr/0016-the-owners-sizing-caps-the-jobs-of-its-computer.md): the owner's sizing caps the jobs of its computer (proposed).
- [ADR 0017](./docs/adr/0017-the-owner-asks-then-takes-as-many-jobs-as-it-has-free-workers.md): the owner asks, then takes as many jobs as it has free workers (proposed).
- [ADR 0018](./docs/adr/0018-news-travels-by-push-through-the-notify-of-the-store-with-a-backstop.md): news travels by push through the notify of the store, with a backstop (proposed).
- [ADR 0019](./docs/adr/0019-run-waits-and-a-failed-job-rejects-with-the-pools-error.md): `run` waits, and a failed job rejects with the pool's error (proposed).
- [ADR 0020](./docs/adr/0020-a-cancel-of-a-shared-job-is-a-leave-and-of-any-other-job-a-drop-or-a-kill.md): a cancel of a shared job is a leave, and of any other job a drop or a kill (proposed).
- [ADR 0021](./docs/adr/0021-a-caller-whose-host-is-gone-cancels-its-jobs-and-the-owner-learns-it-from-a-closed-connection.md): a caller whose host is gone cancels its jobs, and the owner learns it from a closed connection (proposed).
- [ADR 0022](./docs/adr/0022-the-newest-revision-takes-over-and-an-owner-refuses-a-job-of-an-older-revision.md): the newest revision takes over, and an owner refuses a job of an older revision (proposed).
- [ADR 0023](./docs/adr/0023-ownership-moves-only-by-the-owners-own-act-or-its-end-and-a-standby-stays-cold.md): ownership moves only by the owner's own act or its end, and a standby stays cold (proposed).
- [ADR 0024](./docs/adr/0024-a-hung-owner-is-ended-by-the-election-and-its-late-acts-are-fenced.md): a hung owner is ended by the election, and its late acts are fenced (proposed).
- [ADR 0025](./docs/adr/0025-many-computers-share-one-postgres-store-and-each-computer-keeps-its-own-owner.md): many computers share one Postgres store, and each computer keeps its own owner (proposed).
- [ADR 0026](./docs/adr/0026-start-accepts-a-job-now-and-a-job-handle-reads-its-output-later-from-any-host.md): `start` accepts a job now, and a `JobHandle` reads its output later from any host (proposed).
