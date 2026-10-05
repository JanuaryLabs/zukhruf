# SqliteStore

A host lock store that uses an exclusive SQLite transaction as the lock. The operating system kernel releases the lock when the holder stops.

| Reach | Order | Holder process stops | Default token source |
|---|---|---|---|
| Host | No order | Released by the kernel | `FileTokenSource` (durable) |

## What

Each key has one SQLite database file in the shared directory. To hold a key, a process starts an exclusive transaction on that file. To release the key, it ends the transaction. It uses `node:sqlite`, which is part of Node.js.

```ts
import { Mutex, SqliteStore } from 'mutex';

const mutex = new Mutex(new SqliteStore('/var/lib/my-app/locks'));
```

## Why

The file lock stores must find a stopped holder by its process ID. That check can be wrong when the system uses the same ID again. SQLite asks the kernel for the lock, and the kernel removes the lock when the process stops. Thus no process must find or remove a stopped holder.

## When

- More than one process on one host writes to the resource.
- Holder processes can crash, and you want no manual cleanup.
- You do not want to run a server.

## When not

- The order of waiters is important. Use [TicketQueueFileStore](./ticket-queue-file-store.md).
- Many processes wait for one key at the same time. Each waiter keeps one database connection open while it waits.
- You need the key soon after a release. Waiters poll.

## How it works

1. The process opens the key's database file with no busy timeout.
2. It runs `BEGIN EXCLUSIVE`. If another connection has the transaction, SQLite says `SQLITE_BUSY` at once.
3. On `SQLITE_BUSY`, the process waits `pollInterval` and tries again. It does not use a SQLite busy timeout, because that timeout stops the event loop.
4. To release the key, the holder runs `ROLLBACK` and closes the connection.

Do not change the journal mode of these files. The tests use only the default mode.

The transaction ends with `ROLLBACK`, so the fencing token counter cannot be in the database. The default token source keeps it in a counter file next to the database.

## Acquire modes

`tryAcquire` runs `BEGIN EXCLUSIVE` once. A waiter that gives up stops its attempts and closes its connection. See [acquire modes](../concepts/acquire-modes.md).

## Failure modes

- **A holder process stops:** the kernel removes the lock. The next waiter gets the key at its next attempt.
- **A holder thread stops:** the connection closes, and the next waiter gets the key.

See [failure modes](../concepts/failure-modes.md).

## Options

| Option | Default | Description |
|---|---|---|
| `directory` (first argument) | — | The shared directory. |
| `pollInterval` | `10` | Milliseconds between two attempts. |
| `tokens` | `new FileTokenSource(directory)` | The token source. Tokens continue after a restart. |

## Evidence

- A child process held the lock and got `SIGKILL`. The parent got the lock at its next attempt.
- Two connections in one process also exclude each other (`SQLITE_BUSY`, code 5).
- A mutation test changed `BEGIN EXCLUSIVE` to `BEGIN`. Eight tests failed.
