# TicketQueueFileStore

A host lock store that keeps a queue of waiters in a file. It is the only host lock store that grants keys first come, first served.

| Reach | Order                    | Holder process stops                       | Default token source        |
| ----- | ------------------------ | ------------------------------------------ | --------------------------- |
| Host  | First come, first served | Released after a waiter checks the process | `FileTokenSource` (durable) |

## What

Each key has one queue file in the directory that you give. Each waiter adds one line, its ticket, to the end of the file. The waiter whose ticket is first holds the key. All processes that use the same directory share the locks.

```ts
import { Mutex, TicketQueueFileStore } from '@zukhruf/mutex';

const mutex = new Mutex(new TicketQueueFileStore('/var/lib/my-app/locks'));
```

## Why

Some host lock stores do not keep an order. Under heavy load, one waiter can wait for a long time while other waiters get the key. `TicketQueueFileStore` gives the key in the order of the requests. It needs only a directory: no server and no database.

## When

- More than one process on one host writes to the resource.
- The order of the requests is important, or you want no waiter to wait too long.

## When not

- One process does all the writes. Use [MemoryStore](./memory-store.md).
- You need the key soon after a release. Waiters poll, so a waiter can wait up to one `pollInterval` more. [SocketStore](./socket-store.md) tells the waiter at once.
- You stop worker threads that hold keys. The process stays alive, so the key stays held.
- The directory is on a network file system. The safety of the appends depends on a local file system.

## How it works

A ticket is one line of JSON with a process ID, a host name, and a unique ID.

1. **Add a ticket.** The waiter appends its ticket. An append of one small line is atomic on a local file system, so two tickets do not mix.
2. **Wait.** The waiter reads the file every `pollInterval`. When its ticket is first, it holds the key.
3. **Release.** The holder writes the file again without its ticket, to a temporary file, and renames it over the queue file. A rename is atomic.

Only two callers ever write the whole file again: the holder when it releases, and a waiter that removes a stopped holder. These two never occur at the same time. Thus two rewrites never mix.

A rewrite can lose a ticket that a new waiter appended at the same moment. The new waiter sees that its ticket is not in the file, and it appends the ticket again.

**A stopped holder.** If the first ticket belongs to a process that does not exist, a waiter removes that ticket. To do this safely, the waiter first creates `<key>.lock.reclaim`. Only one waiter can create it, so only one waiter removes the ticket.

On a file system that ignores the case of letters (the macOS default), the keys `A` and `a` use the same file. They then share one lock. This makes some callers wait, but it never lets two holders in.

## Acquire modes

`tryAcquire` gives up at once when the queue has a ticket of a live process. A waiter that gives up cannot remove its ticket, because only the head may rewrite the queue. Its ticket stays in line, and a background loop removes it when it reaches the front. That loop does not keep the process alive; if the process stops first, waiters remove the ticket as a stopped holder. See [acquire modes](../concepts/acquire-modes.md).

## Failure modes

- **A holder process stops:** a waiter removes the ticket at its next poll.
- **A holder thread stops:** the key stays held until the process stops.
- **A reused process ID:** a waiter waits until the new process stops. It never gets the key too early.
- **A process stops during a reclaim:** remove `<key>.lock.reclaim` by hand.
- **Windows refuses the lock file for a moment:** another program holds the file open with no sharing, for example a virus scanner, or a delete of the file is in progress. The lock store tries again for up to 1 second. Then it reports the error, because Windows gives the same error for a real permission denial.

See [failure modes](../concepts/failure-modes.md).

## Options

| Option                       | Default                          | Description                                                                                            |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `directory` (first argument) | —                                | The shared directory. All processes must use the same path.                                            |
| `pollInterval`               | `10`                             | Milliseconds between two reads of the queue.                                                           |
| `tokens`                     | `new FileTokenSource(directory)` | The token source. The default keeps one counter file for each key, so tokens continue after a restart. |

## Evidence

- Four processes each did 25 read-then-write increments of one counter file. The counter was 100 at the end, and the fencing tokens increased in the order of the grants.
- A holder process that got `SIGKILL` did not block the next caller.
- A mutation test removed the release step, the removal of stopped holders, and the head check. The tests found each change.
- `src/lock-stores/file-system/ticket-queue-file-store.test.ts` pauses a release before its rename, so that the rename deletes the ticket of a new waiter. The waiter appends its ticket again and gets the key. Without the append again step, this test fails.
