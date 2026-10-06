# @zukhruf/mutex

A mutex for Node.js with interchangeable lock stores. You select who shares the locks: one object, the threads of one process, a parent process and its children, or all processes on one host. The code that uses the mutex stays the same. Each lease has a fencing token, so a resource can refuse the late writes of a holder that lost its key.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## The problem

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
import { MemoryStore, Mutex } from '@zukhruf/mutex';

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

First find who writes to the resource. Then select the lock store with that [reach](./docs/concepts/reach.md).

| Lock store                                                       | Reach                   | Order                                   | A holder stops                  | Needs                       |
| ---------------------------------------------------------------- | ----------------------- | --------------------------------------- | ------------------------------- | --------------------------- |
| [MemoryStore](./docs/stores/memory-store.md)                     | One object              | First come, first served                | The locks stop with the process | Nothing                     |
| [ThreadStore](./docs/stores/thread-store.md)                     | One process (threads)   | First come, first served                | Released when the worker exits  | `adopt(worker)`             |
| [IpcStore](./docs/stores/ipc-store.md)                           | Parent and its children | First come, first served                | Released in approximately 2 ms  | `fork()` and `adopt(child)` |
| [TicketQueueFileStore](./docs/stores/ticket-queue-file-store.md) | One host                | First come, first served                | Released after a process check  | A shared directory          |
| [LockFileStore](./docs/stores/lock-file-store.md)                | One host                | No order                                | Released after a process check  | A shared directory          |
| [SqliteStore](./docs/stores/sqlite-store.md)                     | One host                | First come, first served in one process | Released by the kernel          | A shared directory          |
| [SocketStore](./docs/stores/socket-store.md)                     | One host                | First come, first served                | Released in approximately 2 ms  | A shared directory          |

If you are not sure:

- **One process:** use `MemoryStore`.
- **Several processes on one host:** use `SqliteStore`.

## Acquire modes

A key is exclusive for every caller. The acquire mode decides only what one caller does while the key is busy: wait (the default), or skip.

```ts
import { Modes } from '@zukhruf/mutex';

const report = mutex.key('report:daily', { mode: Modes.skipIfBusy() });

const tick = await report.run(buildReport); // a cron tick skips if a report runs
if (!tick.acquired) return;

const fresh = await report.run(buildReport, { mode: Modes.wait() }); // an admin waits, then runs
await mutex.acquire('product:42', reserve, {
  mode: Modes.skipIfBusy({ waitAtMost: 500 }),
});
```

A mode that can skip returns `{ acquired: true, value } | { acquired: false }`, and TypeScript makes you check `acquired`.

To stop a wait, give a signal to the call: `mutex.acquire(key, task, { signal })`. When the signal aborts, the call rejects with `signal.reason`, and the task does not run. See [Acquire modes](./docs/concepts/acquire-modes.md).

## Fencing tokens

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

See [Fencing tokens](./docs/concepts/fencing-tokens.md) and the recipe [Protect a database from stale holders](./docs/recipes/fence-a-database.md).

## Documentation

**Concepts**

- [Reach](./docs/concepts/reach.md): who can share a lock, and how to select it.
- [Acquire modes](./docs/concepts/acquire-modes.md): wait or skip while a key is busy, and cancel a wait.
- [Fencing tokens](./docs/concepts/fencing-tokens.md): how a resource refuses a stale holder.
- [Leader election](./docs/concepts/leader-election.md): how `SocketStore` selects its coordinator.
- [Failure modes](./docs/concepts/failure-modes.md): what each lock store does when something stops.

**Lock stores**: one page for each lock store, with What, Why, When, When not, How it works, Failure modes, Options, and Evidence. See the table above.

**Recipes**: one use case each, with a full program that you can run.

1. [Stop two requests from selling the last item](./docs/recipes/reserve-the-last-item.md)
2. [Several app instances on one host](./docs/recipes/several-instances-on-one-host.md)
3. [A worker pool that you start](./docs/recipes/worker-pool.md)
4. [Worker threads that share a lock](./docs/recipes/worker-threads.md)
5. [Protect a database from stale holders](./docs/recipes/fence-a-database.md)
6. [Survive a crashed holder](./docs/recipes/survive-a-crashed-holder.md)
7. [Run a job in only one process](./docs/recipes/singleton-job-with-leader-election.md)
8. [Write your own lock store](./docs/recipes/write-your-own-lock-store.md)
9. [Skip a job that is already running](./docs/recipes/skip-a-job-that-is-already-running.md)

**Decisions**: the [architecture decision records](./docs/adr) tell why the design is as it is.

## Use it

This project is an experiment. You need Node.js 26.9 or later.

```sh
npm install @zukhruf/mutex
```

```ts
import { Mutex, SqliteStore } from '@zukhruf/mutex';
import { LeaderElection } from '@zukhruf/mutex/leader-election';
```

## Development

This package is part of the [zukhruf](../../README.md) workspace. Run the commands from the workspace root.

```sh
npm install
npx nx run mutex:test        # builds, then runs all tests in src/
npx nx run mutex:typecheck   # formats, lints, then type checks
npx nx run mutex:build       # compiles src/ to dist/
```

The tests run from `src/`, not from `dist/`: they start workers and child processes from `.ts` files.

```
src/
  mutex/             Mutex, Key, acquire modes, Lease, LockStore, LockLostError
  fencing/           fencing tokens and token sources
  lock-stores/       one folder for each lock store
    remote/          the coordinator and client that ThreadStore, IpcStore and SocketStore share
  leader-election/   leader election (separate entry point, not part of the mutex)
  shared/            small file system and SQLite helpers
  testing/           test helpers and the matrix of lock stores (not published)
docs/
  concepts/  stores/  recipes/  adr/
```

The tests run each lock store through the same scenarios: single process, many threads, many processes, a killed holder, and a failover. Mutation tests broke the mechanisms on purpose, and a test found each break. A test that breaks something stops the run at once (`--test-force-exit`), so a broken release fails in seconds and does not hang.
