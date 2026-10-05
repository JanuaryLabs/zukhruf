# LockFileStore

A host lock store that uses one file for each held key. The process that creates the file holds the key.

| Reach | Order | Holder process stops | Default token source |
|---|---|---|---|
| Host | No order | Released after a waiter checks the process | `FileTokenSource` (durable) |

## What

To get a key, a process creates `<key>.lock` in the shared directory. If the file exists, another process holds the key, and the process tries again later. To release the key, the holder deletes the file.

```ts
import { LockFileStore, Mutex } from 'mutex';

const mutex = new Mutex(new LockFileStore('/var/lib/my-app/locks'));
```

## Why

A lock file is the oldest and easiest way to share a lock between processes. Tools such as git use it. You can see who holds a key: open the file and read the process ID.

## When

- More than one process on one host writes to the resource.
- The order of waiters is not important.
- You want to see the holders with `ls` and `cat`.

## When not

- The order of waiters is important. Use [TicketQueueFileStore](./ticket-queue-file-store.md).
- You need the key soon after a release. Waiters poll.
- You stop worker threads that hold keys. The process stays alive, so the key stays held.

## How it works

1. The process writes its identity (process ID, host name, unique ID) to a temporary file.
2. It creates a hard link from the temporary file to `<key>.lock`. A link fails if the name exists, and it is atomic. Thus the lock file always contains a full identity.
3. If the link fails, the process reads the lock file. If the holder process does not exist, the process removes the lock file and tries again.
4. To release the key, the holder deletes `<key>.lock`.

Removal of a stopped holder uses `<key>.lock.reclaim`, as in [TicketQueueFileStore](./ticket-queue-file-store.md#how-it-works). Without it, two waiters could each remove a lock file that the other waiter had just created.

## Acquire modes

`tryAcquire` makes one attempt. If that attempt finds a stopped holder and removes it, `tryAcquire` makes one more attempt. A waiter that gives up stops its attempts and leaves nothing behind. See [acquire modes](../concepts/acquire-modes.md).

## Failure modes

The same as [TicketQueueFileStore](./ticket-queue-file-store.md#failure-modes): a stopped holder process is removed, a stopped holder thread is not, and a reused process ID makes waiters wait longer.

## Options

| Option | Default | Description |
|---|---|---|
| `directory` (first argument) | — | The shared directory. |
| `pollInterval` | `10` | Milliseconds between two attempts. |
| `tokens` | `new FileTokenSource(directory)` | The token source. Tokens continue after a restart. |

## Evidence

- Four processes each did 25 read-then-write increments. The counter was 100 at the end.
- A mutation test made the file creation not exclusive (a copy, not a link). Eight tests failed, so the tests depend on the exclusive create.
- A mutation test stopped the removal of stopped holders. The test with a killed holder failed.
