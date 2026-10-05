# ThreadStore and ThreadLockCoordinator

A lock store for worker threads. The thread that starts the workers is the coordinator. The workers ask it for keys through their message ports.

| Reach | Order | Holder thread stops | Default token source |
|---|---|---|---|
| Process | First come, first served | Released when the worker emits `exit` | `CounterTokenSource` |

## What

This lock store has two parts:

- **`ThreadLockCoordinator`** runs in the thread that starts the workers, usually the main thread. It keeps the locks. That thread can also use it as a lock store.
- **`ThreadStore`** runs in each worker thread. It sends requests to the coordinator.

The coordinator must **adopt** each worker after it starts the worker:

```ts
// main.ts
import { Worker } from 'node:worker_threads';
import { Mutex, ThreadLockCoordinator } from 'mutex';

const coordinator = new ThreadLockCoordinator();
const worker = new Worker(new URL('./worker.ts', import.meta.url));
coordinator.adopt(worker);
const mutex = new Mutex(coordinator);
```

```ts
// worker.ts
import { Mutex, ThreadStore } from 'mutex';

const mutex = new Mutex(new ThreadStore());
await mutex.acquire('counter', async () => addOne());
```

## Why

Each thread has its own memory, so a `MemoryStore` in one thread cannot help another thread. Node.js has a built-in API for locks between threads, `navigator.locks`, but it can grant one key to two worker threads at the same time ([ADR 0005](../adr/0005-threads-use-a-coordinator-not-web-locks.md)).

A coordinator cannot have that fault: one thread decides every grant. The coordinator uses the same code as [IpcStore](./ipc-store.md) and [SocketStore](./socket-store.md), only with a different channel.

It needs no daemon and no other process. The coordinator is an object in your own thread, and the message ports exist already when you call `new Worker()`.

## When

- Your process uses `worker_threads`, and the threads write to the same resource.
- You start the workers yourself, so you can call `adopt` for each worker.

## When not

- Your process has no worker threads. Use [MemoryStore](./memory-store.md).
- More than one process writes to the resource. Use a host lock store, such as [SqliteStore](./sqlite-store.md). Host lock stores also work between threads.
- The coordinator's thread does long CPU work. While it is busy, it cannot grant keys. Start the workers and the coordinator from a worker thread that does no CPU work.

## How it works

`ThreadStore` sends `acquire` and `release` messages in an envelope (`{ '@lock': … }`) on the worker's port. Your own messages use the same port. **If you listen to `worker.on('message')`, ignore objects that have the property `'@lock'`.**

The coordinator grants keys first come, first served. When a worker stops for any reason, `Worker` emits `exit`, and the coordinator releases the keys of that worker and forgets its requests.

**The worker does not stay alive only for the lock.** A `message` listener on the port keeps a worker alive. `ThreadStore` adds its listener only while it waits for a grant. A message that arrives without a listener waits in the port.

## Failure modes

| Event | Result |
|---|---|
| A worker stops while it holds a key | The coordinator releases the key when the worker emits `exit`. |
| The coordinator's thread is busy | Waiters wait until it is free. In a test, 50 ms of CPU work delayed an answer by 50.2 ms. |
| The process stops | All threads stop. No coordinator or holder is left. |

See [failure modes](../concepts/failure-modes.md).

## Options

`ThreadLockCoordinator`:

| Option | Default | Description |
|---|---|---|
| `tokens` | `new CounterTokenSource()` | The token source. The default starts at 1 when the process starts. |

`ThreadStore` has no options. It throws an error in the main thread, because the main thread has no parent port.

## Evidence

- A message round trip between the main thread and a worker took 8.7 µs on average.
- `src/mutex/mutex.test.ts` (`Cross-thread mutex with ThreadStore`):
  - A thread waits while another thread holds the key.
  - A thread that stops while it holds the key does not block the next caller.
  - A thread whose only work is to wait for a key stays alive and gets it.
  - Four threads add 1 to a shared counter 20 times each. The counter is 80, and no two holders overlap.
- Mutation tests: when the coordinator ignores `exit`, when the worker does not listen while it waits, or when the worker grants itself a key, a test fails.
