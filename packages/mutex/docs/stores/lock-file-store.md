# LockFileStore

A host lock store that uses one file for each held key. The process that creates the file holds the key.

| Reach | Order    | Holder stops                                  | Default token source        |
| ----- | -------- | --------------------------------------------- | --------------------------- |
| Host  | No order | Released after a waiter finds that it stopped | `FileTokenSource` (durable) |

## What

To get a key, a process creates `<key>.lock` in the shared directory. If the file exists, another process holds the key, and the process tries again later. To release the key, the holder deletes the file.

```ts
import { LockFileStore, Mutex } from '@zukhruf/mutex';

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

## How it works

In the file names below, `<key>` is the key, percent-encoded. For example, `/` becomes `%2F`, and `.` becomes `%2E`. A key that is too long for a file name, or that is not well-formed Unicode, gets a short name: the first 32 characters of the encoded key, `%%`, and the SHA-256 digest of the key. The name of a key that fits does not change from version to version, so processes of two versions share its lock.

1. If `<key>.lock` does not exist, the caller starts its [presence](../adr/0012-a-file-store-holder-is-judged-by-its-presence.md): an exclusive SQLite transaction on `<key>.lock.<id>.presence`. The kernel ends the presence when the process or the thread of the caller stops.
2. The caller writes its identity (process ID, host name, unique ID) to a temporary file.
3. It creates a hard link from the temporary file to `<key>.lock`. A link fails if the name exists, and it is atomic. Thus the lock file always contains a full identity.
4. If the link fails, the caller ends its presence and deletes the presence file. Thus a waiter keeps no presence while it waits.
5. If the lock file exists, the caller reads the presence file of the holder. If it can read that file, the holder stopped. The caller then removes the lock file and the presence file, and tries again.
6. To release the key, the holder deletes `<key>.lock`. Then it ends its presence and deletes the presence file.

The process ID and the host name in the lock file are for people. The lock store does not use them.

Removal of a stopped holder uses `<key>.lock.reclaim`, as in [TicketQueueFileStore](./ticket-queue-file-store.md#how-it-works). Without it, two waiters could each remove a lock file that the other waiter had just created. If the lock file names a holder that has no presence file, the acquire fails with an error that gives the names of both files. An older version of the lock store wrote that lock file.

## Acquire modes

`tryAcquire` makes one attempt. If that attempt finds a stopped holder and removes it, `tryAcquire` makes one more attempt. A waiter that gives up stops its attempts and leaves nothing behind. See [acquire modes](../concepts/acquire-modes.md).

## Holder check

`isHeld(key)` reads `<key>.lock` and then the presence file of the holder that it names. A holder that stopped counts as no holder. A holder check does not remove that holder: only a caller that acquires the key removes it. A holder check writes no file, and it does not create the directory. See [ADR 0015](../adr/0015-a-holder-check-never-acquires-the-key.md).

## Failure modes

The same as [TicketQueueFileStore](./ticket-queue-file-store.md#failure-modes): a stopped holder process or thread is removed, also when it is a zombie or it runs in another container on the same machine. A frozen holder keeps the key. On Windows, a lock file that Windows refuses for a moment is tried again for up to 1 second.

## Options

| Option                       | Default                          | Description                                                                                                                   |
| ---------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `directory` (first argument) | —                                | The shared directory. It belongs to the lock store alone: no other program may add, change, or remove files or folders in it. |
| `pollInterval`               | `10`                             | Milliseconds between two attempts.                                                                                            |
| `tokens`                     | `new FileTokenSource(directory)` | The token source. Tokens continue after a restart.                                                                            |

## Evidence

- `src/lock-stores/mixed-version.test.ts`: a process of the latest release and a process of this source share one directory. In both directions, each one sees the holder of the other, does not get its key, and gets the key after the release. The test downloads the latest release each run, so each change is checked against the version that runs beside it during an upgrade.
- Four processes each did 25 read-then-write increments. The counter was 100 at the end.
- A mutation test made the file creation not exclusive (a copy, not a link). Eight tests failed, so the tests depend on the exclusive create.
- A mutation test stopped the removal of stopped holders. The test with a killed holder failed.
- Real containers that share one lock volume: a waiter never takes the key of a live holder in another container, and it gets the key of a holder that was killed in another container. A mutation test that judged holders by process ID failed these tests.
