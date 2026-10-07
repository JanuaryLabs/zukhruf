# IpcStore and IpcLockCoordinator

A lock store for a parent process and the child processes that it starts. The parent is the coordinator. The children ask it for keys through the Node.js IPC channel.

| Reach        | Order                    | Holder process stops           | Default token source |
| ------------ | ------------------------ | ------------------------------ | -------------------- |
| Process tree | First come, first served | Released in approximately 2 ms | `CounterTokenSource` |

## What

This lock store has two parts:

- **`IpcLockCoordinator`** runs in the parent. It keeps the locks. The parent can also use it as a lock store.
- **`IpcStore`** runs in each child. It sends requests to the parent.

The parent must **adopt** each child after it starts the child:

```ts
// parent.ts
import { fork } from 'node:child_process';

import { IpcLockCoordinator, Mutex } from '@zukhruf/mutex';

const coordinator = new IpcLockCoordinator();
const child = fork('./child.ts');
coordinator.adopt(child);
const mutex = new Mutex(coordinator);
```

```ts
// child.ts
import { IpcStore, Mutex } from '@zukhruf/mutex';

const mutex = new Mutex(new IpcStore());
await mutex.acquire('product:42', async () => reserveOneItem());
```

## Why

The IPC channel exists already when you start a child with `fork()`. It needs no files and no network. The operating system closes the channel when a process stops, so the coordinator knows at once that a child stopped. The file lock stores must poll to find this.

## When

- Your app starts its own workers with `fork()` or `cluster`.
- You want fast recovery when a worker stops.

## When not

- The processes do not have one parent, for example two apps started by a process manager. Use a host lock store, such as [SqliteStore](./sqlite-store.md) or [SocketStore](./socket-store.md).
- You do not start the processes yourself. The parent must call `adopt` for each child.

## How it works

On macOS and Linux, the IPC channel between a parent and a child is a pair of connected sockets with no name. Only the parent and that child can use it. A child cannot talk to another child, and a grandchild cannot talk to the parent.

`IpcStore` sends `acquire` and `release` messages in an envelope (`{ '@lock': … }`), so that they do not mix with the messages of your app. The coordinator grants keys first come, first served. When a child stops, the operating system closes the channel. The coordinator then releases the keys of that child and forgets its requests.

**The child does not stay alive only for the lock.** Node.js keeps a child alive while it has listeners on the IPC channel. `IpcStore` adds its listeners only while it waits for a grant or for the answer to a holder check. Thus your child can stop when its own work is done, and your own `message` listeners still control its life.

## Acquire modes

`tryAcquire` sends one `try` request, and the coordinator answers `granted` or `busy` at once. A caller that gives up while it waits sends `cancel`. If the grant was already on its way, the caller gives the key back. See [acquire modes](../concepts/acquire-modes.md).

## Holder check

`isHeld(key)` in a child asks the coordinator of the parent, and the coordinator answers from its memory. `IpcLockCoordinator.isHeld(key)` in the parent answers at once. A coordinator of version 0.3.9 or earlier ignores the request, and the holder check of the child waits. Use one package version in the process tree. See [ADR 0015](../adr/0015-a-holder-check-never-acquires-the-key.md).

## Failure modes

| Event                              | Result                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A child stops while it holds a key | The coordinator releases the key in approximately 2 ms.                                                                                                                                                                                                                                  |
| The parent stops                   | Children that wait get `CoordinatorUnavailableError`. Children that hold a key keep it, because no coordinator is left to grant it ([ADR 0004](../adr/0004-parent-stops-held-keys-stay.md)). On Windows, Node.js stops the children too, unless they were started with `detached: true`. |

See [failure modes](../concepts/failure-modes.md).

## Options

`IpcLockCoordinator`:

| Option   | Default                    | Description                                                       |
| -------- | -------------------------- | ----------------------------------------------------------------- |
| `tokens` | `new CounterTokenSource()` | The token source. The default starts at 1 when the parent starts. |

`IpcStore` has no options. It throws an error if the process has no IPC channel.

## Evidence

- The parent saw the channel close 0.96 ms after a child got `SIGKILL`. The next waiter got the key 1.7 ms after the `SIGKILL`.
- The single-process and cross-process tests in `src/mutex/mutex.test.ts` run against `IpcStore`.
- `Process-tree mutex with IpcStore`: a child that waits gets `CoordinatorUnavailableError` when its parent stops.
- A child that uses `IpcStore` stops by itself after its work, with exit code 0.
