# @zukhruf/mutex

A mutex for Node.js with interchangeable lock stores. You select who shares the locks: one object, the threads of one process, a parent process and its children, all processes on one host, or all machines that reach one server: a Postgres, SQL Server, MySQL or MariaDB database, or a Docker engine. The code that uses the mutex stays the same. Each lease has a fencing token, so a resource can refuse the late writes of a holder that lost its key.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment.

```sh
npm install @zukhruf/mutex
```

```ts
import { Mutex } from '@zukhruf/mutex';
import { SqliteStore } from '@zukhruf/mutex/sqlite';
```

The root `@zukhruf/mutex` gives the core. Each family of lock stores has its own import path: `@zukhruf/mutex/memory`, `/thread`, `/ipc`, `/file-system`, `/sqlite`, `/socket`, `/postgres`, `/sqlserver`, `/mysql`, `/mariadb` and `/docker`. The table in [Select a lock store](#select-a-lock-store) gives the path of each lock store.

## Let one holder at a time run code for a key

Two requests ask for the last item at the same time. Each request reads the stock, waits for the database, and then writes the stock. Both requests read `1`, so both sell the item.

```ts
if (stock > 0) {
  // both requests see 1
  await saveReservation(); // the other request runs here
  stock -= 1; // both requests write
}
```

A mutex lets one holder at a time run this code for a key:

```ts
import { Mutex } from '@zukhruf/mutex';
import { MemoryStore } from '@zukhruf/mutex/memory';

const mutex = new Mutex(new MemoryStore());

const reserved = await mutex.acquire('product:42', async () => {
  if (stock === 0) return false;
  await saveReservation();
  stock -= 1;
  return true;
});
```

The full program is in the recipe [Stop two requests from selling the last item](./docs/recipes/reserve-the-last-item.md).

## Select a lock store

First find who writes to the resource. Then select the lock store with that [reach](./docs/concepts/reach.md). Each family of lock stores has its own import path. The root `@zukhruf/mutex` gives only the core: `Mutex`, `Key`, the acquire modes, `LockStore`, `AcquireOptions`, `LockHandle`, `leaseFor` and `LeaseLostError` ([ADR 0020](./docs/adr/0020-each-store-family-has-its-own-import-path.md)).

| Lock store                                                       | Import                       | Reach                                        | Order                                   | A holder stops                                | Needs                                                       |
| ---------------------------------------------------------------- | ---------------------------- | -------------------------------------------- | --------------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| [MemoryStore](./docs/stores/memory-store.md)                     | `@zukhruf/mutex/memory`      | One object                                   | First come, first served                | The locks stop with the process               | Nothing                                                     |
| [ThreadStore](./docs/stores/thread-store.md)                     | `@zukhruf/mutex/thread`      | One process (threads)                        | First come, first served                | Released when the worker exits                | `adopt(worker)`                                             |
| [IpcStore](./docs/stores/ipc-store.md)                           | `@zukhruf/mutex/ipc`         | Parent and its children                      | First come, first served                | Released in approximately 2 ms                | `fork()` and `adopt(child)`                                 |
| [TicketQueueFileStore](./docs/stores/ticket-queue-file-store.md) | `@zukhruf/mutex/file-system` | One host                                     | First come, first served                | Released after a waiter finds that it stopped | A shared directory                                          |
| [LockFileStore](./docs/stores/lock-file-store.md)                | `@zukhruf/mutex/file-system` | One host                                     | No order                                | Released after a waiter finds that it stopped | A shared directory                                          |
| [SqliteStore](./docs/stores/sqlite-store.md)                     | `@zukhruf/mutex/sqlite`      | One host                                     | First come, first served in one process | Released by the kernel                        | A shared directory                                          |
| [SocketStore](./docs/stores/socket-store.md)                     | `@zukhruf/mutex/socket`      | One host                                     | First come, first served                | Released in approximately 2 ms                | A shared directory                                          |
| [PostgresStore](./docs/stores/postgres-store.md)                 | `@zukhruf/mutex/postgres`    | Every machine that reaches the database      | Postgres' lock queue                    | Released when its session ends                | A Postgres database and a `connect` function                |
| [SqlServerStore](./docs/stores/sqlserver-store.md)               | `@zukhruf/mutex/sqlserver`   | Every machine that reaches the database      | SQL Server's lock queue                 | Released when its session ends                | A SQL Server database and a `connect` function              |
| [MysqlStore](./docs/stores/mysql-store.md)                       | `@zukhruf/mutex/mysql`       | Every machine that reaches the database      | MySQL's lock queue                      | Released when its session ends                | A MySQL database and a `connect` function                   |
| [MariadbStore](./docs/stores/mariadb-store.md)                   | `@zukhruf/mutex/mariadb`     | Every machine that reaches the database      | MariaDB's lock queue                    | Released when its session ends                | A MariaDB database and a `connect` function                 |
| [DockerEngineStore](./docs/stores/docker-engine-store.md)        | `@zukhruf/mutex/docker`      | Every machine that reaches the Docker engine | No order between processes              | Released when its attach ends                 | A Docker engine, an image with `cat`, and `@zukhruf/docker` |

If you are not sure:

- **One process:** use `MemoryStore`.
- **Several processes on one host:** use `SqliteStore`.
- **Many machines that already use Postgres:** use `PostgresStore`.
- **Many machines that already use SQL Server:** use `SqlServerStore`.
- **Many machines that already use MySQL:** use `MysqlStore`.
- **Many machines that already use MariaDB:** use `MariadbStore`.
- **Many machines that already use one Docker engine, with no database:** use `DockerEngineStore`.

## Wait or skip while a key is busy

A key is exclusive for every caller. The acquire mode decides only what one caller does while the key is busy: wait (the default), or skip.

```ts
import { Modes } from '@zukhruf/mutex';

const report = mutex.key('report:daily', { mode: Modes.skipIfBusy() });

const tick = await report.run(buildReport); // a cron tick skips if a report runs
if (!tick.acquired) return;

const fresh = await report.run(buildReport, { mode: Modes.wait() }); // an admin waits, then runs
await mutex.acquire('product:42', reserve, {
  mode: Modes.skipIfBusy({ waitAtMost: 500, clock: globalThis }),
});
```

A mode that can skip returns `{ acquired: true, value } | { acquired: false }`, and TypeScript makes you check `acquired`.

To stop a wait, give a signal to the call: `mutex.acquire(key, task, { signal })`. When the signal aborts, the call rejects with `signal.reason`, and the task does not run. See [Acquire modes](./docs/concepts/acquire-modes.md).

## Check if a key has a holder

A status view must show if a task runs, but it must not make the key busy. `isHeld` tells if a key has a holder now, and it never acquires the key:

```ts
const running = await report.isHeld(); // or: await mutex.isHeld('report:daily')
```

A caller that skips if busy is never refused because of a holder check. The holder can change before the answer arrives, so show the answer, but do not acquire a key because of it: an acquire mode decides that. See [ADR 0015](./docs/adr/0015-a-holder-check-never-acquires-the-key.md).

## Refuse the writes of a stale holder

A holder can lose its key and not know it, for example when its process freezes. Each lease has a fencing token that increases with each grant. Send the token with each write, and let the resource refuse lower tokens:

```ts
await mutex.acquire('product:42', async (lease) => {
  await database.run(
    `UPDATE stock SET quantity = quantity - 1, fence = ?
		 WHERE product = ? AND fence <= ? AND quantity > 0`,
    [lease.token.value, 'product:42', lease.token.value],
  );
});
```

Sometimes the lock store sees the loss, for example after a failover of `SocketStore`. Then the signal of the lease aborts with `LeaseLostError`, and the task can stop before its next write. When the task ends, the call rejects with `LeaseLostError`:

```ts
await mutex.acquire('product:42', async (lease) => {
  for (const order of orders) {
    lease.signal.throwIfAborted();
    await ship(order, lease.token);
  }
});
```

The signal is a warning. A frozen holder can write before its lock store sees the loss, so the fencing token is still the protection.

The lease is a `FencedLease` of [`@zukhruf/fencing`](../fencing/README.md). Import `FencingToken` and the token sources from `@zukhruf/fencing`. `LeaseLostError` is from [`@zukhruf/lease`](../lease/README.md), and this package also exports it, because its calls reject with it.

See [Fencing tokens](./docs/concepts/fencing-tokens.md) and the recipe [Protect a database from stale holders](./docs/recipes/fence-a-database.md).

## Errors

| Error                         | When                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LeaseLostError`              | Another holder may have the key now. The signal of the lease aborts with it while the task runs, and the call rejects with it when the task ends. Its `subject` is the key. It is the class of `@zukhruf/lease`, and `@zukhruf/mutex` exports it too ([ADR 0013](./docs/adr/0013-a-lost-lease-aborts-the-signal-of-the-lease.md)). |
| `CoordinatorUnavailableError` | No coordinator is left that can grant the key, for example after the parent of an `IpcStore` stops. The request did not run. Its `key` is the key. `@zukhruf/mutex/thread`, `/ipc` and `/socket` export it ([ADR 0004](./docs/adr/0004-parent-stops-held-keys-stay.md)).                                                           |
| `GrantFailedError`            | The coordinator could not mint a fencing token for the key. The request did not run, and the key is not held. Its `key` is the key. `@zukhruf/mutex/thread`, `/ipc` and `/socket` export it ([ADR 0019](./docs/adr/0019-a-failed-token-mint-answers-the-request-and-an-exhausted-epoch-ends-the-term.md)).                         |
| `ProtocolVersionError`        | The leader of a `SocketStore` speaks another protocol version. The request did not run. `ours` is the protocol version of this process, and `theirs` is the protocol version of the leader. `@zukhruf/mutex/socket` exports it ([ADR 0014](./docs/adr/0014-a-process-says-its-protocol-version-before-its-first-request.md)).      |
| `NetworkDirectoryError`       | The lock directory of a `TicketQueueFileStore`, `LockFileStore`, `SqliteStore` or `SocketStore` is on a network file system. `directory` and `fileSystem` name it. It is the class of `@zukhruf/fs`, and `@zukhruf/mutex/file-system`, `/sqlite` and `/socket` export it (`src/lock-stores/network-directory.test.ts`).            |
| `signal.reason`               | A call rejects with it when its signal aborts while it waits for the key. The task does not run ([ADR 0008](./docs/adr/0008-a-caller-cancels-an-acquire-mode-gives-up.md)).                                                                                                                                                        |

## Who uses it

| Consumer                                    | How                                                                                                                                                                                                                                                                                          | Record                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `@eltjs/elt-sqlite` (elt)                   | `SQLiteCheckpointStore` holds one key of `SqliteStore` for each copy `id`, in a `<path>.locks` folder, with `Modes.skipIfBusy()`. A copy that already runs fails fast. It replaces one `BEGIN IMMEDIATE` transaction on the file for the full run.                                           | its ADR 0005, elt 229349b2 |
| `@eltjs/elt-sqlserver` (elt)                | `SqlServerCheckpointStore` holds one key of `SqlServerStore` for each copy `id`, with `Modes.skipIfBusy()`, as `SQLiteCheckpointStore` does. It is in place of raw `sp_getapplock` calls.                                                                                                    | its ADR 0009, elt a6d215a6 |
| `@eltjs/source-google-search-console` (elt) | `SearchConsoleScan` keeps a `Mutex` of `MemoryStore`, and its inspection streams of one property run one at a time with `acquire(siteUrl, …)`, so no URL is inspected twice.                                                                                                                 | elt 000da177               |
| `@sdk-it/vite` (sdk-it)                     | `OutputFolder` holds a key of `SqliteStore` for each output folder, so a dev server and a build on one host never write the folder at the same time.                                                                                                                                         | sdk-it 09a5f9a3            |
| `@deepagents/experimental` (deepagents)     | The Claude and ChatGPT credential refresh holds the key `'claude'` or `'chatgpt'` of `SqliteStore` in `<home>/.deepagents-locks`. The conversation status projector serializes its steps for each key with a `Mutex` of `MemoryStore`. It replaces `proper-lockfile` and `createKeyedQueue`. | deepagents e561e551        |
| `@workspace/backend` (text2sql)             | One index run at a time for each data source: `indexing.acquire(dataSourceId, …)` on a `Mutex` of `MemoryStore`. It replaces `SpaceIndexLock`.                                                                                                                                               | text2sql ef8bbfb7          |

## API

The root `@zukhruf/mutex`. `FencedLease` and `TokenSource` are types of `@zukhruf/fencing`, and `Clock` is a type of `@zukhruf/async`.

```ts
class Mutex {
  constructor(store: LockStore);
  acquire<T>(
    key: string,
    task: (lease: FencedLease) => Promise<T>,
    options?: AcquireOptions & { mode?: undefined },
  ): Promise<T>;
  acquire<T, O extends Outcome>(
    key: string,
    task: (lease: FencedLease) => Promise<T>,
    options: AcquireOptions & { mode: AcquireMode<O> },
  ): Promise<OutcomeResults<T>[O]>;
  isHeld(key: string): Promise<boolean>;
  key(name: string, options?: { mode?: undefined }): Key<'always'>;
  key<O extends Outcome>(
    name: string,
    options: { mode: AcquireMode<O> },
  ): Key<O>;
}

class Key<O extends Outcome> {
  readonly name: string;
  constructor(mutex: Mutex, name: string, mode: AcquireMode<O>);
  isHeld(): Promise<boolean>;
  run<T>(
    task: (lease: FencedLease) => Promise<T>,
    options?: AcquireOptions & { mode?: undefined },
  ): Promise<OutcomeResults<T>[O]>;
  run<T, P extends Outcome>(
    task: (lease: FencedLease) => Promise<T>,
    options: AcquireOptions & { mode: AcquireMode<P> },
  ): Promise<OutcomeResults<T>[P]>;
}

interface AcquireOptions {
  signal?: AbortSignal | undefined; // the call rejects with signal.reason
}

// Acquire modes
type Outcome = 'always' | 'maybe';

interface AcquireMode<O extends Outcome = Outcome> {
  readonly outcome: O;
  acquire(
    store: LockStore,
    key: string,
    options: AcquireOptions,
  ): Promise<LockHandle | undefined>; // undefined: this caller gives up
}

interface Acquired<T> {
  readonly acquired: true;
  readonly value: T;
}
interface NotAcquired {
  readonly acquired: false;
}
interface OutcomeResults<T> {
  always: T;
  maybe: Acquired<T> | NotAcquired;
}
type ModeResult<M extends AcquireMode, T> = OutcomeResults<T>[M['outcome']];

const Modes: {
  wait: () => WaitMode;
  skipIfBusy: (options?: SkipIfBusyOptions) => SkipIfBusyMode;
};
class WaitMode implements AcquireMode<'always'> {}
class SkipIfBusyMode implements AcquireMode<'maybe'> {
  constructor(options?: SkipIfBusyOptions); // no options: one attempt only
}
interface SkipIfBusyOptions {
  waitAtMost: number; // milliseconds, from the answer that the key is busy
  clock: Clock;
}

// A lock store of your own
interface LockStore {
  acquire(key: string, options?: AcquireOptions): Promise<LockHandle>;
  tryAcquire(key: string): Promise<LockHandle | undefined>;
  isHeld(key: string): Promise<boolean>; // never acquires the key
}
interface LockHandle extends FencedLease, AsyncDisposable {}
function leaseFor(
  key: string,
  held: AsyncDisposable,
  tokens: TokenSource,
): Promise<LockHandle>; // mints the token, and releases `held` if the mint fails

// from @zukhruf/lease
class LeaseLostError extends Error {
  readonly subject: string; // the key
  constructor(subject: string, options?: ErrorOptions);
}
```

## Documentation

**Concepts**

- [Reach](./docs/concepts/reach.md): who can share a lock, and how to select it.
- [Acquire modes](./docs/concepts/acquire-modes.md): wait or skip while a key is busy, and cancel a wait.
- [Fencing tokens](./docs/concepts/fencing-tokens.md): how a resource refuses a stale holder.
- [Leader election](../election/docs/concepts/leader-election.md): how `SocketStore` selects its coordinator, with `SqliteElection` of `@zukhruf/election`.
- [Failure modes](./docs/concepts/failure-modes.md): what each lock store does when something stops.

**Lock stores**: one page for each lock store, with What, Why, When, When not, How it works, Acquire modes, Holder check, Failure modes, Options, and Evidence. The `SocketStore` page also has Protocol version. See the table above.

**Recipes**: one use case each, with a full program that you can run.

1. [Stop two requests from selling the last item](./docs/recipes/reserve-the-last-item.md)
2. [Several app instances on one host](./docs/recipes/several-instances-on-one-host.md)
3. [A worker pool that you start](./docs/recipes/worker-pool.md)
4. [Worker threads that share a lock](./docs/recipes/worker-threads.md)
5. [Protect a database from stale holders](./docs/recipes/fence-a-database.md)
6. [Survive a crashed holder](./docs/recipes/survive-a-crashed-holder.md)
7. [Run a job in only one process](../election/docs/recipes/singleton-job-with-leader-election.md), with `@zukhruf/election`
8. [Write your own lock store](./docs/recipes/write-your-own-lock-store.md)
9. [Skip a job that is already running](./docs/recipes/skip-a-job-that-is-already-running.md)
10. [Compute a value once and share it](./docs/recipes/compute-once-and-share-it.md)
11. [Hold several keys for one run, or skip the run](./docs/recipes/hold-several-keys-or-none.md)

**Decisions**: the [architecture decision records](./docs/adr) tell why the design is as it is.

- [ADR 0001](./docs/adr/0001-every-process-is-a-candidate.md): every process is a candidate.
- [ADR 0002](./docs/adr/0002-election-is-not-part-of-the-mutex.md): leader election is not part of the mutex (superseded by `@zukhruf/election` ADR 0001).
- [ADR 0003](./docs/adr/0003-a-fencing-token-on-every-lease.md): a fencing token on every lease.
- [ADR 0004](./docs/adr/0004-parent-stops-held-keys-stay.md): when the parent stops, held keys stay held.
- [ADR 0005](./docs/adr/0005-threads-use-a-coordinator-not-web-locks.md): threads use a coordinator, not Web Locks.
- [ADR 0006](./docs/adr/0006-acquire-modes-are-strategies-over-two-store-operations.md): acquire modes are strategies over two lock store operations.
- [ADR 0007](./docs/adr/0007-the-connection-is-separate-from-the-lock-requests.md): the connection to a coordinator is separate from the lock requests.
- [ADR 0008](./docs/adr/0008-a-caller-cancels-an-acquire-mode-gives-up.md): a caller cancels with a signal; an acquire mode gives up.
- [ADR 0009](./docs/adr/0009-a-phase-is-a-state-object-a-latch-or-an-event.md): a phase is a state object, a latch, or an event.
- [ADR 0010](./docs/adr/0010-the-time-limit-of-skip-if-busy-counts-only-the-wait-for-a-holder.md): the time limit of skip if busy counts only the wait for a holder.
- [ADR 0011](./docs/adr/0011-a-windows-refusal-of-a-lock-file-is-tried-again-for-a-limited-time.md): a Windows refusal of a lock file is tried again for a limited time.
- [ADR 0012](./docs/adr/0012-a-file-store-holder-is-judged-by-its-presence.md): a file store holder is judged by its presence.
- [ADR 0013](./docs/adr/0013-a-lost-lease-aborts-the-signal-of-the-lease.md): a lost lease aborts the signal of the lease.
- [ADR 0014](./docs/adr/0014-a-process-says-its-protocol-version-before-its-first-request.md): a process says its protocol version before its first request.
- [ADR 0015](./docs/adr/0015-a-holder-check-never-acquires-the-key.md): a holder check never acquires the key.
- [ADR 0016](./docs/adr/0016-a-leader-lists-the-requests-that-it-added.md): a leader lists the requests that it added (superseded by ADR 0014).
- [ADR 0017](./docs/adr/0017-a-connection-closes-only-when-its-framing-breaks.md): a connection closes only when its framing breaks.
- [ADR 0018](./docs/adr/0018-the-next-leader-skips-the-grace-window-after-a-clean-shutdown.md): the next leader skips the grace window after a clean shutdown.
- [ADR 0019](./docs/adr/0019-a-failed-token-mint-answers-the-request-and-an-exhausted-epoch-ends-the-term.md): a failed token mint answers the request, and an exhausted epoch ends the term.
- [ADR 0020](./docs/adr/0020-each-store-family-has-its-own-import-path.md): each family of lock stores has its own import path.
- [ADR 0021](./docs/adr/0021-a-lock-store-can-reach-every-machine-that-reaches-one-server.md): a lock store can reach every machine that reaches one server.
- [ADR 0022](./docs/adr/0022-a-database-lock-store-takes-its-session-from-the-caller.md): a database lock store takes its session from the caller.
- [ADR 0023](./docs/adr/0023-a-postgres-waiter-is-cancelled-by-closing-its-session.md): a Postgres waiter is cancelled by closing its session.
- [ADR 0024](./docs/adr/0024-a-sql-server-holder-check-reads-the-lock-view.md): a SQL Server holder check reads the lock view.
- [ADR 0025](./docs/adr/0025-a-mysql-family-lock-belongs-to-one-database.md): a MySQL-family lock belongs to one database.
- [ADR 0026](./docs/adr/0026-a-docker-engine-key-is-a-named-container-that-lives-while-its-holder-attaches.md): a Docker engine key is a named container that lives while its holder attaches.
- [ADR 0027](./docs/adr/0027-docker-engine-tokens-come-from-a-ladder-of-named-volumes.md): Docker engine tokens come from a ladder of named volumes (superseded in part by ADR 0028).
- [ADR 0028](./docs/adr/0028-a-docker-engine-token-is-the-higher-of-the-engine-time-and-the-ladder.md): a Docker engine token is the higher of the engine time and the ladder.
- [ADR 0029](./docs/adr/0029-a-docker-engine-store-marks-its-claims-and-rungs-with-the-labels-of-the-caller.md): a Docker engine store marks its claims and rungs with the labels of the caller.
- [ADR 0030](./docs/adr/0030-each-lock-store-runs-the-lock-store-contract-from-its-own-tests-and-a-capability-is-a-typed-parameter.md): each lock store runs the lock-store contract from its own tests, and a capability is a typed parameter.
- [ADR 0031](./docs/adr/0031-a-follower-observes-the-leader-so-a-frozen-leader-is-ended.md): a follower observes the leader, so a frozen leader is ended.
- [ADR 0032](./docs/adr/0032-a-cancelled-waiter-of-the-memory-store-leaves-the-line.md): a cancelled waiter of the memory store leaves the line.

**Copied code**: [Code that is in two places](./docs/copied-code.md) records each copy of code in this package, as the Rule of Three asks.

## Development

This package is part of the [zukhruf](../../README.md) workspace. Run the commands from the workspace root.

```sh
npm install
npx nx run mutex:test        # builds, then runs the tests in src/
npx nx run mutex:typecheck   # formats, lints, then type checks
npx nx run mutex:build       # compiles src/ to dist/
```

The tests run from `src/`, not from `dist/`: they start workers and child processes from `.ts` files.

```
src/
  mutex/             Mutex, Key, acquire modes, LockHandle, LockStore
  lock-stores/       one folder for each lock store
    remote/          the coordinator and client that ThreadStore, IpcStore and SocketStore share
  shared/            a record check (key file names, file writes and file locks are in @zukhruf/fs)
  testing/           test helpers, the lock-store contract and the subject of each lock store (not published)
docs/
  concepts/  stores/  recipes/  adr/
```

The tests run each lock store through the same scenarios: single process, many threads, many processes, a killed holder, and a failover. Mutation tests broke the mechanisms on purpose, and a test found each break. A test that breaks something stops the run at once (`--test-force-exit`), so a broken release fails in seconds and does not hang.
