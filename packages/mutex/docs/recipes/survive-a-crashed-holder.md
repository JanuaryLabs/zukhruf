# Recipe: Survive a crashed holder

**Use case.** A process holds a key and crashes before it releases the key. The other processes must not wait forever.

**Lock store.** Select a lock store that releases the key of a stopped process. For the reach of a host, all host lock stores do this, in different ways.

## Select a lock store

| Lock store                                                                                                  | How it finds a stopped holder                                                | Time to the next grant                        |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------- |
| [SqliteStore](../stores/sqlite-store.md)                                                                    | The kernel removes the file lock.                                            | The next attempt of a waiter (`pollInterval`) |
| [SocketStore](../stores/socket-store.md)                                                                    | The kernel closes the connection to the leader.                              | Approximately 2 ms                            |
| [IpcStore](../stores/ipc-store.md)                                                                          | The kernel closes the IPC channel to the parent.                             | Approximately 2 ms                            |
| [TicketQueueFileStore](../stores/ticket-queue-file-store.md), [LockFileStore](../stores/lock-file-store.md) | The kernel ends the presence of the holder, and a waiter removes the holder. | The next attempt of a waiter                  |

All these methods ask the kernel, so none depends on process IDs. They also work for a zombie process, and for containers that share one lock directory on one machine.

## The program

A child process holds the key `nightly-report` and gets `SIGKILL` before it releases the key. Then the parent asks for the same key.

```ts title="crashed-holder.ts"
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Mutex, SqliteStore } from '@zukhruf/mutex';

const [role, shared] = process.argv.slice(2);

if (role === 'holder') {
  setInterval(() => {}, 1000); // Stay alive until the parent kills this process.
  const mutex = new Mutex(new SqliteStore(shared!));
  await mutex.acquire('nightly-report', async () => {
    process.send!('holding');
    await new Promise(() => {}); // The crash occurs before the release.
  });
} else {
  const directory = await mkdtemp(join(tmpdir(), 'crash-'));
  const holder = fork(import.meta.filename, ['holder', directory]);
  await once(holder, 'message');

  holder.kill('SIGKILL');
  await once(holder, 'exit');
  const crashed = performance.now();

  const mutex = new Mutex(new SqliteStore(directory));
  await mutex.acquire('nightly-report', async () => {
    console.log(
      `got the key ${Math.round(performance.now() - crashed)} ms after the crash`,
    );
  });
  await rm(directory, { recursive: true, force: true });
}
```

Output (the time changes from run to run):

```
got the key 1 ms after the crash
```

## Why it works

SQLite asks the kernel for the file lock. When a process stops for any reason, also `SIGKILL`, the kernel removes all its file locks. Thus the next `BEGIN EXCLUSIVE` succeeds.

## Things to know

- **A crash is not a freeze.** A frozen process keeps its key, because it can continue at any time. Only a [fenced resource](./fence-a-database.md) protects you from a frozen holder.
- **The work of the crashed holder can be half done.** The lock store releases the key, but it cannot undo the writes. Use database transactions for work that must be all or nothing.
- **Worker threads are the same.** If a thread stops but its process does not, the kernel ends the locks of that thread, and the key is released. See [failure modes](../concepts/failure-modes.md).
