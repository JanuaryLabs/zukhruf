# @zukhruf/pool

One pool of long-lived workers for each computer. A worker is costly to start: a native helper that loads a model, or a command-line agent that keeps a session. Every program that needs a worker sends its jobs to one store on the computer, and one of them, the owner, runs the jobs on its workers. The owner starts the workers, lends each one to one job at a time, replaces a worker that exits, and closes an idle worker. You choose three things from standard classes: when the workers start (a startup), how many run (a sizing), and when an idle worker closes (an eviction).

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @zukhruf/pool
```

```ts
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Fixed,
  NoEviction,
  Parallel,
  Pool,
  PoolWorkers,
  type Worker,
  WorkerKind,
} from '@zukhruf/pool';

const upper = new WorkerKind<string, string>({
  name: 'upper',
  revision: 1,
  policy: 'standard',
  retryLimit: 0,
  expireInSeconds: 60,
});

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
    this.#exit.resolve();
  }
}

// A store of its own; a host of the computer gives computerStore(process.env).
await using folder = await mkdtempDisposable(join(tmpdir(), 'pool-'));
const store = join(folder.path, 'store.sqlite');

await using workers = new PoolWorkers({
  kind: upper,
  store,
  clock: globalThis,
  size: new Fixed(2),
  startup: new Parallel(),
  eviction: new NoEviction(),
  create: () => new Upper(),
});
await using pool = new Pool({ kind: upper, store, clock: globalThis });

const words = await Promise.all(
  ['one', 'two', 'three'].map((word) => pool.run(word)),
);
await workers.ready();
console.log(words, workers.stats);
// [ 'ONE', 'TWO', 'THREE' ] { starting: 0, idle: 2, lent: 0, waiting: 0 }
```

The program offers two workers, owns them, and sends three jobs. The owner runs the jobs on its workers, one job for each worker at a time. After the jobs, both workers are idle. The disposals at the end of the program stop sending, hand the workers over, and close them.

## Define the worker kind

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

## Send jobs, and offer workers

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

Each host on the computer that builds a `PoolWorkers` of the kind offers its workers, and the election picks one of them as the owner. The others are standbys: they start no workers until they own. A host that cannot run the worker program builds only the `Pool`.

A worker gives `run(input)`, `exited()`, `kill()`, `close()`, and optionally `ready()`. `run` does one job and resolves with its output ([ADR 0012](./docs/adr/0012-a-job-is-data-and-the-worker-kind-runs-it.md)). A `Coprocess` of `@zukhruf/coprocess` has all of them except `run`, so a worker class keeps the `Coprocess` and gives its `request` as `run`.

A test gives a store of its own, so it never joins the user's pool:

```ts
await using scratch = await mkdtempDisposable(join(tmpdir(), 'pool-'));
const store = join(scratch.path, 'store.sqlite');
```

## Read an output later

A host that answers at once starts the job, and reads its output later, from this host or another:

```ts
const { id } = await ocr.start({ path: '/tmp/receipt.png' });
// later, in any host with a Pool of the same kind and revision
const { text } = await ocr.handle(id).result({ signal });
```

The job outlives the host that started it. A handle reads the job until the store's retention ends: 7 days after the job settled. The abort of `signal` ends only the wait of `result`. `cancel()` of the handle ends the job ([ADR 0026](./docs/adr/0026-start-accepts-a-job-now-and-a-job-handle-reads-its-output-later-from-any-host.md)).

## Cancel a job

The abort of the signal of `run` cancels its job, and `run` rejects with the signal's reason. `cancel()` of a handle does the same. A job that waits is dropped. The owner kills the worker of a job that runs at its next touch, at most 5 s on, and the next job starts a worker in that slot after the back-off of an early exit. The cancel of a job of an `exclusive` kind is a leave: the job runs to its end for the other callers that gave the same input ([ADR 0020](./docs/adr/0020-a-cancel-of-a-shared-job-is-a-leave-and-of-any-other-job-a-drop-or-a-kill.md)).

## How the owner lends its workers

A job takes an idle worker first. When no worker is idle, the job takes a worker that starts. Only when no worker starts does the job start a new worker. Of the idle workers, a job takes the one in the lowest slot. Thus jobs one at a time use one worker, and the other idle workers stay idle until their eviction lets them go.

The owner waits for `ready()` with no time limit. Thus, if the warm-up of a worker can wait forever, the worker sets its own time limit, and `ready()` rejects when that limit ends. The owner then kills and closes the worker, and the job that waits for it fails. An eager startup starts a worker in that slot again after a back-off (see [Replace a worker that exits](#replace-a-worker-that-exits)). With `OnDemand`, the next job starts a new worker.

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

| Eviction                 | Evicts                                                                       |
| ------------------------ | ---------------------------------------------------------------------------- |
| `NoEviction`             | no worker. Each idle worker stays until the owner disposes its `PoolWorkers` |
| `IdleTimeout({ after })` | a worker that stays idle for `after` milliseconds                            |

A job that takes the worker before `after` ends keeps it. When the job ends, a new `after` starts. `after` is a number of milliseconds above 0 and at most 2,147,483,647. Another value throws a `RangeError`, because Node runs a timer with a larger delay after 1 ms.

Mature pools give these idle times: the .NET thread pool 20 s, generic-pool 30 s, KEDA and the Kubernetes HPA 300 s before they scale down, and HikariCP 10 minutes. A worker that is costly to start, such as a helper that loads a model, needs a long time. A worker that holds much memory needs a short time.

The pool evicts only a worker in a slot that the sizing runs. A worker that the sizing keeps but does not run stays alive for the next step of the sizing ([ADR 0002](./docs/adr/0002-a-sizing-that-learns-compares-one-more-worker-between-two-windows.md)). The next job that needs an evicted slot starts a new worker. See [ADR 0006](./docs/adr/0006-the-pool-evicts-an-idle-worker-that-its-eviction-lets-go-and-lends-an-idle-worker-first.md).

## Read the stats

`workers.stats` counts the slots of this host, for example in a health check:

```ts
const { starting, idle, lent, waiting } = workers.stats;
const { waiting: queued, running } = await pool.stats();
```

| Count      | Is                                                                  |
| ---------- | ------------------------------------------------------------------- |
| `starting` | the workers that start and are not ready yet                        |
| `idle`     | the ready workers that no job has                                   |
| `lent`     | the ready workers that a job has                                    |
| `waiting`  | the jobs that the owner took and that wait for a worker that starts |

Each count is zero while the host does not own. A worker that exited is in no count, and a slot whose worker the owner evicted is in no count. Each read makes a new object, so the counts of one read agree with each other. See [ADR 0004](./docs/adr/0004-a-pool-reports-its-stats-as-one-snapshot-of-counts.md).

`pool.stats()` gives the jobs of the kind in the store, the same from every host: `waiting`, the jobs that wait for a worker or for a retry, and `running`, the jobs that a worker runs. It lags up to one pass of the store's monitor, a second ([ADR 0013](./docs/adr/0013-pool-sends-jobs-and-pool-workers-offers-the-workers-of-its-host.md)).

## Replace a worker that exits

A job that needs the slot of an exited worker starts a new worker. An eager startup also replaces an idle worker that exits. After an early exit (a worker that ran less than 10 minutes), the pool waits first: 1 s, then 2 s, 4 s, and so on up to 60 s for each early exit in a row. A worker that runs 10 minutes ends this back-off. A job does not wait for a back-off: its worker starts now. Kubernetes restarts a container in CrashLoopBackOff with the same rule. The pool does not count an evicted worker as an exit: it does not replace the worker and does not start a back-off. An evicted worker that ran 10 minutes ends the back-off too. See [ADR 0005](./docs/adr/0005-an-eager-pool-backs-off-before-it-replaces-a-worker-that-exited-early.md).

A worker whose warm-up fails is an early exit too. An eager startup starts that slot again after the back-off, also when a job started the worker, so the pool has warm workers again before the next job. See [ADR 0010](./docs/adr/0010-an-eager-pool-starts-a-worker-again-after-its-warm-up-fails.md).

## Run the pool on a clock

The owner measures the time of each job, waits before it replaces a worker that exited early, and gives the eviction the clock for its waits. All of these run on the `clock` that you give. Give `globalThis` in production. A test gives `createClock()` of `@sinonjs/fake-timers` and moves it with `await clock.tickAsync(ms)`, so a back-off of 60 seconds or a sizing window of 2 seconds takes no real time ([`@zukhruf/async`](../async/README.md#run-a-wait-on-a-clock)).

An eviction of your own gets the clock of the pool as the third argument of `idle(busy, evict, clock)`, so the owner and its eviction always run on one clock. See [ADR 0008](./docs/adr/0008-the-pool-measures-and-waits-on-the-clock-that-the-caller-gives.md).

The store keeps the wall time of each job, so `Pool` and `PoolWorkers` take a `WallClock` of [`@zukhruf/async`](../async/README.md). The backstops of the owner and of each `Pool` run on it too, so a test that never moves its clock still runs each job: the wakes of the store carry the news.

## The rules

- **One owner.** On each computer, one host owns the workers of a pool. `PoolWorkers` leads in a `SqliteElection` of [`@zukhruf/election`](../election/README.md), with the claim files in the folder of the store, through a `LeaderSelector` with `autoRequeue`: the host owns for each term that it wins, and campaigns again after each term, as client-go's `LeaderElector` does. The other hosts with a `PoolWorkers` are standbys ([ADR 0011](./docs/adr/0011-every-pool-is-a-pool-for-the-computer-and-one-owner-pulls-its-jobs-from-a-store-that-every-host-writes-to.md)).
- **The two roles.** `Pool` sends. `PoolWorkers` offers workers and has no `run`. They meet only through the worker kind and the store, as BullMQ's `Queue` and `Worker` meet through the queue name ([ADR 0013](./docs/adr/0013-pool-sends-jobs-and-pool-workers-offers-the-workers-of-its-host.md)).
- **A job is data.** The input and the output are JSON. A file goes by reference: a path on one computer. The code of a job is the worker's `run` ([ADR 0012](./docs/adr/0012-a-job-is-data-and-the-worker-kind-runs-it.md)).
- **The store** is a required address. A path of a SQLite file is the store of one computer, through [`@zukhruf/sqlite-queue`](../sqlite/queue/README.md). A `postgres://` address joins computers, through pg-boss. `computerStore(env)` gives `zukhruf-pool/store.sqlite` in the user's state folder: `$HOME/Library/Application Support` on macOS, `$XDG_STATE_HOME` (or `$HOME/.local/state`) on Linux, `%LOCALAPPDATA%` on Windows. It reads `process.platform`, and takes `env` as its input, as Go's `os.UserConfigDir` reads `runtime.GOOS`. Every `Pool` and `PoolWorkers` opens the store and creates the queue of its revision ([ADR 0015](./docs/adr/0015-the-store-is-a-required-input-and-computer-store-gives-the-store-of-the-computer.md)).
- **The clock.** The store keeps the wall time of each job, so `Pool` and `PoolWorkers` take a `WallClock` of [`@zukhruf/async`](../async/README.md): `globalThis` in production. The pool gives `@zukhruf/sqlite-queue` pg-boss's clock, made from it.
- **A failure of the store** that no caller waits for, in a pass of the store, a fetch, a touch or a settle of the owner, is a process warning, and the owner keeps owning: the next pass, backstop or touch tries again, and a job whose settle failed lapses by its heartbeat and runs again by the kind's rules, as pg-boss emits the failure of a pass and keeps polling. Ownership ends only by the election or the disposal. A campaign that fails is a process warning too, and the host campaigns again after client-go's `RetryPeriod` of 2 s with its `JitterFactor` of 1.2: 2 s to 4.4 s on the pool's clock, as client-go, Curator's `autoRequeue` and Spring's `LockRegistryLeaderInitiator` try again. A store that fails to start ends the host, and the disposal of `PoolWorkers` rejects with that failure. A store whose folder is on a network file system is such a store: its start rejects with `NetworkDirectoryError` before the election campaigns, because the file locks of the store and of the election do not hold there.
- **The disposal** of `PoolWorkers` can run again, or at the same time: each call waits for the one end of the host, which closes the store last.
- **The cap.** The owner's sizing caps the jobs of its computer. The store keeps no count of running jobs. A new owner starts its sizing fresh ([ADR 0016](./docs/adr/0016-the-owners-sizing-caps-the-jobs-of-its-computer.md)).
- **The owner asks, then takes.** It calls `fetch(name, { batchSize: free })` on the queue of its revision for its free workers, settles each job with `complete` or `fail` by its attempt, and calls `touch` for each running job every 5 s on a heartbeat of 10 s. It fetches when a worker becomes free, at a "new job" wake, and at the backstop ([ADR 0017](./docs/adr/0017-the-owner-asks-then-takes-as-many-jobs-as-it-has-free-workers.md)).
- **News travels by push.** Two channels for each pool: "a new job", with the revision, which the owner hears, and "an output", with the job id, which each waiting `Pool` hears. On one computer they go through [`@zukhruf/sqlite-notify`](../sqlite/notify/README.md), across computers through Postgres `LISTEN` / `NOTIFY`. The store is the truth, and a wake only says "read the store". A backstop each second on one computer finds a lost wake, and a job that the store's monitor failed ([ADR 0018](./docs/adr/0018-news-travels-by-push-through-the-notify-of-the-store-with-a-backstop.md)).
- **`run` waits** for the output. The kind's `retryLimit` decides how often a job runs again, its `expireInSeconds` limits one run, and the caller's `signal` limits only the caller's wait. With no owner anywhere, the job waits in the store. `run` is `start`, then `result` ([ADR 0019](./docs/adr/0019-run-waits-and-a-failed-job-rejects-with-the-pools-error.md)).
- **Accept now, read later.** `start(input)` resolves with a `JobHandle { id, result({ signal }), cancel() }`, and `handle(id)` gives the handle of a job from any host, as Temporal's `start` and `getHandle`. The job outlives the host that started it. A handle reads the job until the store's retention ends: 7 days after the job settled ([ADR 0026](./docs/adr/0026-start-accepts-a-job-now-and-a-job-handle-reads-its-output-later-from-any-host.md)).
- **A cancel.** The caller's abort of a shared job is a leave: its `run` rejects, and the job runs to its end for the other callers. The abort of any other job drops it when it waits, and the owner kills its worker at its next touch, at most 5 s on, when it runs. `cancel()` of a handle does the same ([ADR 0020](./docs/adr/0020-a-cancel-of-a-shared-job-is-a-leave-and-of-any-other-job-a-drop-or-a-kill.md); Ezz, 2026-11-14: "we need to follow top perfoerms").
- **A caller that is gone.** Each job of a `run` of a standard kind carries its caller's address: a pipe of [`@zukhruf/pipes`](../pipes/README.md), `/tmp/zukhruf-pool-<uid>/<id>`, that its `Pool` serves from its construction to its disposal. A job of `start` carries none, and neither does a job of an exclusive kind, which other callers may share. The owner connects to the address before it starts the job, and keeps the connection while the job runs. A refused connect cancels the job before it runs; a close, when the caller's program dies or its `Pool` is disposed, cancels it and kills its worker at once, as gRPC cancels a call when the client's connection closes ([ADR 0021](./docs/adr/0021-a-caller-whose-host-is-gone-cancels-its-jobs-and-the-owner-learns-it-from-a-closed-connection.md)). Each such `Pool` also holds a presence file beside the store, `<store>.callers/<id>.presence` (`Presence` of [`@zukhruf/fs`](../fs/README.md)), from before its pipe serves until after it closes. macOS refuses a connect to a live caller whose listen queue is full with the `ECONNREFUSED` of a gone one, so on a refused connect the presence decides: the job of a caller that lives runs, and its presence is read at each touch; a gone caller's presence file is removed (#5424).
- **Revisions.** Each revision has its own queue, `<name>.r<revision>`, so an older owner never fetches a job of a newer revision, as Temporal routes a task by its build id. The store holds the deprecation: once a host of a newer revision started on the store, the `start` and `run` of an older host reject at once with `DeprecatedRevisionError`, a job of the older revision that still waits rejects its `result` with it, an older owner finishes its running jobs and resigns at the newer host's start, and an older host never owns again, its `ready()` rejecting with the error when it never owned, as Amazon SWF refuses a task of a deprecated type ([ADR 0022](./docs/adr/0022-the-newest-revision-takes-over-and-the-store-deprecates-every-older-revision.md)).
- **Ownership moves** only by the owner's own act or its end. A standby starts no workers until it owns. A clean owner finishes its jobs and resigns. The jobs of a dead owner come back by their heartbeat. `ready()` never resolves on a standby ([ADR 0023](./docs/adr/0023-ownership-moves-only-by-the-owners-own-act-or-its-end-and-a-standby-stays-cold.md)).
- **A hung owner** is ended by the election: a standby that hears no heartbeat on the leader's pipe for 15 s kills the leader's process. A late `complete` of the old owner affects 0 rows ([ADR 0024](./docs/adr/0024-a-hung-owner-is-ended-by-the-election-and-its-late-acts-are-fenced.md)).
- **Many computers** will share one Postgres store, and each computer will elect its own owner. It is built only when a second computer is real; today a `postgres://` store throws a `TypeError` ([ADR 0025](./docs/adr/0025-many-computers-share-one-postgres-store-and-each-computer-keeps-its-own-owner.md)).

## Not built yet

- Many computers on one Postgres store ([ADR 0025](./docs/adr/0025-many-computers-share-one-postgres-store-and-each-computer-keeps-its-own-owner.md)).

## Errors

| Error                     | When                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JobFailedError`          | `run` or `result` rejects with it when the job failed its last run. `failure` has the name and the message that the owner stored, for example the worker's error, or "handler execution exceeded 60s", or the store's "job heartbeat timeout" ([src/pool-workers.test.ts](./src/pool-workers.test.ts)).                                                                                         |
| `JobCancelledError`       | `run` or `result` rejects with it when the job was cancelled, by `cancel()` of a handle or by the abort of a `run` of another caller.                                                                                                                                                                                                                                                           |
| `JobNotFoundError`        | `result` rejects with it when the store has no job with the id: it was deleted after the retention, it belongs to another revision, or it never existed.                                                                                                                                                                                                                                        |
| `DeprecatedRevisionError` | `start`, `run` or `result` rejects with it, and `ready()` of a host that never owned, when the store holds a newer revision of the kind: update the host. `kind`, `revision` and `newest` name the kind, the host's revision and the newest ([src/pool-workers.test.ts](./src/pool-workers.test.ts)).                                                                                           |
| `DisposedError`           | `run`, `result`, `start` or `cancel()` rejects with it when the host disposed its `Pool`, also while it waited.                                                                                                                                                                                                                                                                                 |
| The reason of `signal`    | `run` or `result` rejects with it when the caller's signal aborted.                                                                                                                                                                                                                                                                                                                             |
| `RangeError`              | `new WorkerKind` gets a name whose channel `<name>.new-job` has 64 bytes or more ([src/worker-kind.test.ts](./src/worker-kind.test.ts)).                                                                                                                                                                                                                                                        |
| `RangeError`              | `new IdleTimeout({ after })` gets an `after` that is not above 0 and at most 2,147,483,647 ([src/pool.test.ts](./src/pool.test.ts)).                                                                                                                                                                                                                                                            |
| `TypeError`               | `new Pool` or `new PoolWorkers` gets a `postgres://` store. Only the store of one computer, the path of a SQLite file, is built ([src/pool-workers.test.ts](./src/pool-workers.test.ts)).                                                                                                                                                                                                       |
| `Error`                   | `computerStore(env)` finds no `$HOME` on macOS, no `$HOME` and no `$XDG_STATE_HOME` on Linux, or no `%LOCALAPPDATA%` on Windows ([src/computer-store.test.ts](./src/computer-store.test.ts)).                                                                                                                                                                                                   |
| `NetworkDirectoryError`   | The disposal and `ready()` of `PoolWorkers`, and `start` of a `Pool`, reject with it when the folder of the store is on a network file system, where file locks are not shared reliably between machines. `fileSystem` names the file system, for example `NFS`. The class is the one of [`@zukhruf/fs`](../fs/README.md) ([src/pool-workers.test.ts](./src/pool-workers.test.ts), Linux only). |
| The failure of the store  | The disposal of `PoolWorkers`, and `start` of a `Pool`, reject with the failure of the store's start, for example an `expireInSeconds` that the store refuses ([src/pool-workers.test.ts](./src/pool-workers.test.ts)). A later failure of the store is a process warning.                                                                                                                      |
| The error of the warm-up  | `workers.ready()` rejects with it when a worker that the startup of the owner starts fails its `ready()` ([src/pool-workers.test.ts](./src/pool-workers.test.ts)).                                                                                                                                                                                                                              |
| `AbortError`              | `workers.ready()` rejects with it when you dispose `PoolWorkers` before its host owns ([src/pool-workers.test.ts](./src/pool-workers.test.ts)).                                                                                                                                                                                                                                                 |

`instanceof` of each error and warning of the pool is true also for one that another copy of the package threw, of any version that has the brand, because the class checks for its symbol brand, not for its own prototype ([ADR 0027](./docs/adr/0027-a-pool-error-is-recognized-across-copies-of-the-package-by-a-symbol-brand.md)).

A failure that no caller waits for is a process warning, in the shape of [root ADR 0010](../../docs/adr/0010-a-package-warning-names-its-type-code-and-subject-and-keeps-the-failure-as-its-cause.md). A `'warning'` listener reads its type as `name`, its `code`, and its subject in `detail`, one `<term>: <value>` line each. Its `cause` is the failure, and its message ends with the failure's message. `--disable-warning=<code or type>` stops the print. `PoolWarning` is a class that the package exports, and so is `LeaderSelectorWarning` of [`@zukhruf/election`](../election/README.md); the `code` of each names the condition, so a listener can test `warning instanceof` the class ([root ADR 0011](../../docs/adr/0011-a-package-warning-is-an-instance-of-its-own-class-which-the-package-exports.md)). With two installed copies of the package, `instanceof` fails across the copies, so compare `code`.

| Warning                 | Code                                               | Detail                          | When                                                                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PoolWarning`           | `ZUKHRUF_POOL_QUEUE_ERROR`                         | `queue: <name>`                 | The queue of the store emits `'error'`. The pool goes on.                                                                                                                                                                             |
| `PoolWarning`           | `ZUKHRUF_POOL_NOTIFICATIONS_ERROR`                 | `queue: <name>`                 | The notifications of the store emit `'error'`. The backstop finds the lost wakes.                                                                                                                                                     |
| `PoolWarning`           | `ZUKHRUF_POOL_NOTIFY_FAILED`                       | `channel: <channel>`            | A notify fails after its write committed. The backstop finds the lost wake.                                                                                                                                                           |
| `PoolWarning`           | `ZUKHRUF_POOL_OWNER_CONNECTION_ERROR`              | `queue: <name>`                 | The connection of an owner to a `Pool` breaks. The pool drops it.                                                                                                                                                                     |
| `PoolWarning`           | `ZUKHRUF_POOL_FETCH_FAILED`                        | `queue: <name>`                 | A fetch of the owner fails. The owner waits for the backstop.                                                                                                                                                                         |
| `PoolWarning`           | `ZUKHRUF_POOL_SETTLE_FAILED`                       | `queue: <name>` and `job: <id>` | The settle of a job fails. The job lapses by its heartbeat.                                                                                                                                                                           |
| `PoolWarning`           | `ZUKHRUF_POOL_TOUCH_FAILED`                        | `queue: <name>` and `job: <id>` | A touch of a job fails. The job keeps its worker, and the next touch tries again.                                                                                                                                                     |
| `PoolWarning`           | `ZUKHRUF_POOL_CALLER_CONNECTION_ERROR`             | `queue: <name>`                 | The connection of the owner to the caller of a job breaks for a reason other than a caller that is gone. The owner treats the caller as gone.                                                                                         |
| `PoolWarning`           | `ZUKHRUF_POOL_REVISIONS_READ_FAILED`               | `queue: <name>`                 | A read of the revisions in the store fails. The host reads again at its next wake of a newer revision or its next term ([ADR 0022](./docs/adr/0022-the-newest-revision-takes-over-and-the-store-deprecates-every-older-revision.md)). |
| `PoolWarning`           | `ZUKHRUF_POOL_CALLER_PRESENCE_REMOVE_FAILED`       | `queue: <name>`                 | The removal of a gone caller's presence file fails. The file stays for the next owner that finds that caller gone (#5424).                                                                                                            |
| `LeaderSelectorWarning` | `ZUKHRUF_ELECTION_LEADER_SELECTOR_CAMPAIGN_FAILED` | `election: <claim file>`        | A campaign of the host fails. The host waits 2 s to 4.4 s on its clock and campaigns again, and its `ready()` stays pending ([ADR 0024](./docs/adr/0024-a-hung-owner-is-ended-by-the-election-and-its-late-acts-are-fenced.md)).      |

## API

```ts
import type { Clock, WallClock } from '@zukhruf/async';

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

class Pool<Input, Output> implements AsyncDisposable {
  constructor(options: {
    kind: WorkerKind<Input, Output>;
    store: string; // the path of the store's SQLite file, such as computerStore(process.env)
    clock: WallClock;
  }); // TypeError: a postgres:// store
  start(input: Input): Promise<JobHandle<Output>>; // resolves when the store has the job
  handle(id: string): JobHandle<Output>; // reads nothing
  run(input: Input, options?: { signal?: AbortSignal }): Promise<Output>; // start, then result; the abort of signal cancels the job
  stats(): Promise<JobCounts>; // the jobs of the kind in the store
  [Symbol.asyncDispose](): Promise<void>; // ends the waits with DisposedError, cancels the jobs of waiting runs
}

interface JobHandle<Output> {
  readonly id: string;
  result(options?: { signal?: AbortSignal }): Promise<Output>; // the abort of signal ends only this wait
  cancel(): Promise<void>; // a leave for a shared job; a drop or a kill for any other job
}

interface JobCounts {
  readonly waiting: number;
  readonly running: number;
}

class PoolWorkers<Input, Output> implements AsyncDisposable {
  constructor(options: {
    kind: WorkerKind<Input, Output>;
    store: string;
    clock: WallClock;
    create: () => Worker<Input, Output>;
    size: Sizing;
    startup: Startup;
    eviction: Eviction;
  }); // TypeError: a postgres:// store
  readonly stats: PoolStats; // this host's slots; each count 0 while it does not own
  ready(): Promise<void>; // the host owns and its startup's workers are ready; rejects with DeprecatedRevisionError on a host that never owned
  [Symbol.asyncDispose](): Promise<void>; // a hand-over; rejects with the failure of the store's start, NetworkDirectoryError too
}

function computerStore(env: Record<string, string | undefined>): string;

interface Worker<Input, Output> {
  run(input: Input): Promise<Output>;
  ready?(): Promise<unknown>;
  exited(): Promise<unknown>;
  kill(): void;
  close(): Promise<void>;
}

class JobFailedError extends Error {
  readonly failure: Failure;
}
class JobCancelledError extends Error {}
class JobNotFoundError extends Error {}
class DeprecatedRevisionError extends Error {
  readonly kind: string;
  readonly revision: number; // this host's
  readonly newest: number; // the newest in the store
}
class DisposedError extends Error {}
// Re-exported: NetworkDirectoryError of @zukhruf/fs, LeaderSelectorWarning of @zukhruf/election.

class PoolWarning extends Error {
  readonly code: PoolWarningSubject['code'];
  readonly detail: string; // the subject, one line each
  constructor(failure: unknown, subject: PoolWarningSubject);
}

type PoolWarningSubject =
  // the code with its subject
  | { readonly code: 'ZUKHRUF_POOL_NOTIFY_FAILED'; readonly channel: string }
  | {
      readonly code: 'ZUKHRUF_POOL_SETTLE_FAILED' | 'ZUKHRUF_POOL_TOUCH_FAILED';
      readonly queue: string;
      readonly job: string;
    }
  | {
      readonly code:
        | 'ZUKHRUF_POOL_QUEUE_ERROR'
        | 'ZUKHRUF_POOL_NOTIFICATIONS_ERROR'
        | 'ZUKHRUF_POOL_OWNER_CONNECTION_ERROR'
        | 'ZUKHRUF_POOL_FETCH_FAILED'
        | 'ZUKHRUF_POOL_REVISIONS_READ_FAILED'
        | 'ZUKHRUF_POOL_CALLER_PRESENCE_REMOVE_FAILED'
        | 'ZUKHRUF_POOL_CALLER_CONNECTION_ERROR';
      readonly queue: string;
    };

interface Failure {
  readonly name: string;
  readonly message: string;
}

interface Sizing {
  readonly ceiling: number; // the most workers it may run, decided when the owner builds its slots
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
- [ADR 0011](./docs/adr/0011-every-pool-is-a-pool-for-the-computer-and-one-owner-pulls-its-jobs-from-a-store-that-every-host-writes-to.md): every pool is a pool for the computer, and one owner pulls its jobs from a store that every host writes to.
- [ADR 0012](./docs/adr/0012-a-job-is-data-and-the-worker-kind-runs-it.md): a job is data, and the worker kind runs it.
- [ADR 0013](./docs/adr/0013-pool-sends-jobs-and-pool-workers-offers-the-workers-of-its-host.md): `Pool` sends jobs, and `PoolWorkers` offers the workers of its host.
- [ADR 0014](./docs/adr/0014-pool-and-pool-workers-take-one-worker-kind.md): `Pool` and `PoolWorkers` take one worker kind.
- [ADR 0015](./docs/adr/0015-the-store-is-a-required-input-and-computer-store-gives-the-store-of-the-computer.md): the store is a required input, and `computerStore` gives the store of the computer.
- [ADR 0016](./docs/adr/0016-the-owners-sizing-caps-the-jobs-of-its-computer.md): the owner's sizing caps the jobs of its computer.
- [ADR 0017](./docs/adr/0017-the-owner-asks-then-takes-as-many-jobs-as-it-has-free-workers.md): the owner asks, then takes as many jobs as it has free workers.
- [ADR 0018](./docs/adr/0018-news-travels-by-push-through-the-notify-of-the-store-with-a-backstop.md): news travels by push through the notify of the store, with a backstop.
- [ADR 0019](./docs/adr/0019-run-waits-and-a-failed-job-rejects-with-the-pools-error.md): `run` waits, and a failed job rejects with the pool's error.
- [ADR 0020](./docs/adr/0020-a-cancel-of-a-shared-job-is-a-leave-and-of-any-other-job-a-drop-or-a-kill.md): a cancel of a shared job is a leave, and of any other job a drop or a kill.
- [ADR 0021](./docs/adr/0021-a-caller-whose-host-is-gone-cancels-its-jobs-and-the-owner-learns-it-from-a-closed-connection.md): a caller whose host is gone cancels its jobs, and the owner learns it from a closed connection.
- [ADR 0022](./docs/adr/0022-the-newest-revision-takes-over-and-the-store-deprecates-every-older-revision.md): the newest revision takes over, and the store deprecates every older revision.
- [ADR 0023](./docs/adr/0023-ownership-moves-only-by-the-owners-own-act-or-its-end-and-a-standby-stays-cold.md): ownership moves only by the owner's own act or its end, and a standby stays cold.
- [ADR 0024](./docs/adr/0024-a-hung-owner-is-ended-by-the-election-and-its-late-acts-are-fenced.md): a hung owner is ended by the election, and its late acts are fenced.
- [ADR 0025](./docs/adr/0025-many-computers-share-one-postgres-store-and-each-computer-keeps-its-own-owner.md): many computers share one Postgres store, and each computer keeps its own owner.
- [ADR 0026](./docs/adr/0026-start-accepts-a-job-now-and-a-job-handle-reads-its-output-later-from-any-host.md): `start` accepts a job now, and a `JobHandle` reads its output later from any host.
- [ADR 0027](./docs/adr/0027-a-pool-error-is-recognized-across-copies-of-the-package-by-a-symbol-brand.md): a pool error is recognized across copies of the package by a symbol brand.
