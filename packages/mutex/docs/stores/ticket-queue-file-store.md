# TicketQueueFileStore

A host lock store that keeps a queue of waiters in a file. It is the only host lock store that grants keys first come, first served.

| Reach | Order                    | Holder stops                                  | Default token source        |
| ----- | ------------------------ | --------------------------------------------- | --------------------------- |
| Host  | First come, first served | Released after a waiter finds that it stopped | `FileTokenSource` (durable) |

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
- The directory is on a network file system. The safety of the appends depends on a local file system.

## How it works

The queue file of a key is `<key>.lock`. In the file names below, `<key>` is the key, percent-encoded. For example, `/` becomes `%2F`, and `.` becomes `%2E`. A key that is too long for a file name, or that is not well-formed Unicode, gets a short name: the first 32 characters of the encoded key, `%%`, and the SHA-256 digest of the key. The name of a key that fits does not change from version to version, so processes of two versions share its lock.

A ticket is one line of JSON with a process ID, a host name, and a unique ID. The process ID and the host name are for people. While its ticket is in the queue, each caller keeps a [presence](../adr/0012-a-file-store-holder-is-judged-by-its-presence.md): an exclusive SQLite transaction on `<key>.lock.<id>.presence`. The kernel ends the presence when the process or the thread of the caller stops.

1. **Add a ticket.** The waiter starts its presence. Then it appends its ticket. An append of one small line is atomic on a local file system, so two tickets do not mix.
2. **Wait.** The waiter reads the file every `pollInterval`. When its ticket is first, it holds the key.
3. **Release.** The holder writes the file again without its ticket, to a temporary file, and renames it over the queue file. A rename is atomic. Then the holder ends its presence and deletes the presence file.

Only two callers ever write the whole file again: the holder when it releases, and a waiter that removes a stopped holder. These two never occur at the same time. Thus two rewrites never mix.

A rewrite can lose a ticket that a new waiter appended at the same moment. The new waiter sees that its ticket is not in the file, and it appends the ticket again.

**A stopped caller.** A waiter reads the presence file of the first ticket. If it can read that file, the caller of that ticket stopped. The waiter then takes `<key>.lock.reclaim`, an exclusive SQLite transaction. Only one waiter at a time can have it. The waiter reads the queue again. If the same ticket is still first, the waiter removes that ticket and its presence file. It does the same for the next ticket while that ticket also belongs to a stopped caller.

The waiter reads the presence before it reads the queue. A stopped caller never writes again, so the queue that the waiter writes back is current. If a ticket has no presence file, the acquire fails with an error that gives the names of both files. An older version of the lock store wrote that ticket.

On a file system that ignores the case of letters (the macOS default), the keys `A` and `a` use the same file. They then share one lock. This makes some callers wait, but it never lets two holders in.

## Acquire modes

`tryAcquire` first removes the tickets of stopped callers at the front of the queue. Then it gives up at once if the queue still has a ticket. A waiter that gives up cannot remove its ticket, because only the head may rewrite the queue. It ends its presence instead. Its ticket then belongs to a stopped caller, and the next waiter that finds it at the front removes it. See [acquire modes](../concepts/acquire-modes.md).

## Failure modes

- **A holder process or thread stops:** a waiter removes the ticket at its next poll. This is also true for a zombie process, and for a holder in another container on the same machine.
- **A holder freezes:** its presence stays, so it keeps the key. Only a [fenced resource](../concepts/fencing-tokens.md) can refuse its late writes.
- **A waiter stops during a reclaim:** the kernel ends its reclaim lock, and the next waiter removes the stopped caller.
- **A ticket or a reclaim file of an older version:** the acquire fails with an error that gives the names of the files. Stop the processes that use the older version. Then delete the files.
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
- A mutation test read the queue before the presence of its first ticket. Four processes that wait, skip, and give up in turn then failed. With the correct order, no two callers held the key at the same time.
- `src/lock-stores/file-system/ticket-queue-file-store.test.ts` pauses a release before its rename, so that the rename deletes the ticket of a new waiter. The waiter appends its ticket again and gets the key. Without the append again step, this test fails.
