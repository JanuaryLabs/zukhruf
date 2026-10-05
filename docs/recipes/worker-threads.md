# Recipe: Worker threads that share a lock

**Use case.** One process runs worker threads. The threads share memory, for example a `SharedArrayBuffer`. They read and write it with an `await` between the read and the write. Only one thread at a time must do this.

**Lock store.** [ThreadLockCoordinator and ThreadStore](../stores/thread-store.md). The thread that starts the workers is the coordinator, and the reach is one process.

## The steps

1. In the main thread, create one `ThreadLockCoordinator`.
2. Start each worker with `new Worker()`.
3. Call `coordinator.adopt(worker)` for each worker, at once after `new Worker()`.
4. In each worker, create the mutex with `new ThreadStore()`.
5. The main thread can also use the coordinator as its lock store.

## The program

The main thread and three worker threads each add 1 to a shared counter 20 times. Each addition reads the counter, waits one event loop turn, and then writes the counter.

```ts title="threads.ts"
import { once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { isMainThread, Worker, workerData } from 'node:worker_threads';
import { Mutex, ThreadLockCoordinator, ThreadStore, type LockStore } from 'mutex';

async function addTwenty(store: LockStore, counter: Int32Array) {
	const mutex = new Mutex(store);
	for (let i = 0; i < 20; i++) {
		await mutex.acquire('counter', async () => {
			const value = counter[0]!;
			await nextTurn(); // Other threads run here.
			counter[0] = value + 1;
		});
	}
}

if (isMainThread) {
	const counter = new Int32Array(new SharedArrayBuffer(4));
	const coordinator = new ThreadLockCoordinator();
	const exits = [1, 2, 3].map(() => {
		const worker = new Worker(new URL(import.meta.url), { workerData: counter });
		coordinator.adopt(worker);
		return once(worker, 'exit');
	});
	await addTwenty(coordinator, counter);
	await Promise.all(exits);
	console.log('counter:', counter[0]);
} else {
	await addTwenty(new ThreadStore(), workerData as Int32Array);
}
```

Output:

```
counter: 80
```

## Why it works

The main thread keeps all locks in its memory. Each worker sends its requests through the message port that `new Worker()` made. One thread decides every grant, so two threads never hold the key at the same time.

## Why not `navigator.locks`

Node.js has a built-in API for locks between threads. Do not use it for this. Node.js 26 grants one exclusive lock to two worker threads at the same time: with this program and `navigator.locks`, the counter was 79 in some runs. See [ADR 0005](../adr/0005-threads-use-a-coordinator-not-web-locks.md).

## Things to know

- **A worker that stops while it holds a key** releases it. The coordinator sees the worker's `exit` event.
- **Your own `worker.on('message')` listeners** also get the lock messages. Ignore objects with the property `'@lock'`.
- **The coordinator's thread must stay free.** While it does CPU work, no key is granted.
- **No daemon is necessary.** The coordinator is an object in your main thread.
- **Host lock stores also work between threads**, for example `SqliteStore`. Use one of them if the threads and other processes share the resource.
