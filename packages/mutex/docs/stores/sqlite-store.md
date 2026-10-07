# SqliteStore

A host lock store that uses an exclusive SQLite transaction as the lock. The operating system kernel releases the lock when the holder stops.

| Reach | Order                                                               | Holder process stops   | Default token source        |
| ----- | ------------------------------------------------------------------- | ---------------------- | --------------------------- |
| Host  | First come, first served in one process; no order between processes | Released by the kernel | `FileTokenSource` (durable) |

## What

Each key has one SQLite database file in the shared directory. To hold a key, a process starts an exclusive transaction on that file. To release the key, it ends the transaction. It uses `node:sqlite`, which is part of Node.js.

```ts
import { Mutex, SqliteStore } from '@zukhruf/mutex';

const mutex = new Mutex(new SqliteStore('/var/lib/my-app/locks'));
```

## Why

SQLite asks the kernel for the lock, and the kernel removes the lock when the process stops. Thus no process must find or remove a stopped holder. The file lock stores use the same kernel lock as a [presence](../adr/0012-a-file-store-holder-is-judged-by-its-presence.md), but they still remove the file of a stopped holder.

## When

- More than one process on one host writes to the resource.
- Holder processes can crash, and you want no manual cleanup.
- You do not want to run a server.

## When not

- The order of waiters across processes is important. Use [TicketQueueFileStore](./ticket-queue-file-store.md).
- You need the key soon after a release. Waiters poll.

## How it works

The database file of a key is `<key>.lock`, the folder of its holder is `<key>.lock.holder`, and the token file of the default `FileTokenSource` is `<key>.fence`. In these names, `<key>` is the key, percent-encoded. For example, `/` becomes `%2F`, and `.` becomes `%2E`. A key that is too long for a file name, or that is not well-formed Unicode, gets a short name: the first 32 characters of the encoded key, `%%`, and the SHA-256 digest of the key. The name of a key that fits does not change from version to version, so processes of two versions share its lock.

1. Callers in one process first line up in a queue in memory, in the order of their calls. Only the first caller in that queue continues to the next step. Thus one process keeps at most one database file open for each key, however many callers wait.
2. That caller opens the key's database file with no busy timeout.
3. It runs `BEGIN EXCLUSIVE`. If another connection has the transaction, SQLite says `SQLITE_BUSY` at once.
4. On `SQLITE_BUSY`, the caller waits `pollInterval` and tries again. It does not use a SQLite busy timeout, because that timeout stops the event loop.
5. The holder writes its name for a [holder check](#holder-check). It starts its [presence](../adr/0012-a-file-store-holder-is-judged-by-its-presence.md) on `<key>.lock.holder/caller.<id>.presence`. Then it writes its identity to `<key>.lock.holder/caller`. Then it deletes the other files in `<key>.lock.holder`: holders that stopped left them there. Only the holder of the key writes in this folder.
6. To release the key, the holder deletes `caller`, ends its presence, and deletes its presence file. Then it runs `ROLLBACK` and closes the connection, also when a delete failed. Then the next caller in the in-process queue continues.

Do not change the journal mode of these files. The tests use only the default mode.

The transaction ends with `ROLLBACK`, so the fencing token counter cannot be in the database. The default token source keeps it in a counter file next to the database.

## Acquire modes

`tryAcquire` gives up at once if another caller in this process holds or waits for the key. Otherwise it runs `BEGIN EXCLUSIVE` once. A waiter that gives up stops its attempts and closes its connection, or leaves the in-process queue. See [acquire modes](../concepts/acquire-modes.md).

## Holder check

`isHeld(key)` reads `<key>.lock.holder/caller` and then the presence file that it names. It never opens `<key>.lock`. A read of that file makes the key busy for a caller that runs `BEGIN EXCLUSIVE` at the same moment, so a holder check that read it could make a caller that skips if busy give up on a free key. A holder that stopped counts as no holder. A holder check writes no file, and it does not create the directory.

The holder folder belongs to the lock store. If another program removes `caller` while the key is held, holder checks do not see the holder, and the release rejects with `ENOENT` for `caller`. The key is free after that release.

A holder of version 0.3.9 or earlier writes no `caller` file, so a holder check of a later version does not see that holder. Use one package version in all processes that share the directory. See [ADR 0015](../adr/0015-a-holder-check-never-acquires-the-key.md).

## Failure modes

- **A holder process stops:** the kernel removes the lock. The next waiter gets the key at its next attempt.
- **A holder thread stops:** the connection closes, and the next waiter gets the key.

See [failure modes](../concepts/failure-modes.md).

## Options

| Option                       | Default                          | Description                                                                                                                   |
| ---------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `directory` (first argument) | —                                | The shared directory. It belongs to the lock store alone: no other program may add, change, or remove files or folders in it. |
| `pollInterval`               | `10`                             | Milliseconds between two attempts.                                                                                            |
| `tokens`                     | `new FileTokenSource(directory)` | The token source. Tokens continue after a restart.                                                                            |

## Evidence

- A child process held the lock and got `SIGKILL`. The parent got the lock at its next attempt.
- Two connections in one process also exclude each other (`SQLITE_BUSY`, code 5).
- A mutation test changed `BEGIN EXCLUSIVE` to `BEGIN`. Eight tests failed.
- `src/lock-stores/sqlite/sqlite-store.test.ts`: fifty callers that wait in one process add no open files (before the in-process queue, they added fifty), and callers in one process get the key in the order of their calls.
