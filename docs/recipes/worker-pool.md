# Recipe: A worker pool that you start

**Use case.** Your app starts its own worker processes with `fork()`. The workers and the parent write to the same resource. Only one process at a time must do the write.

**Lock store.** [IpcLockCoordinator and IpcStore](../stores/ipc-store.md). The parent is the coordinator, and the reach is the process tree.

## The steps

1. In the parent, create one `IpcLockCoordinator`.
2. Start each worker with `fork()`.
3. Call `coordinator.adopt(worker)` for each worker, at once after `fork()`.
4. In each worker, create the mutex with `new IpcStore()`.
5. The parent can also use the coordinator as its lock store.

## The program

Three workers and the parent each add 1 to a counter file 20 times.

```ts title="worker-pool.ts"
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IpcLockCoordinator, IpcStore, Mutex, type LockStore } from 'mutex';

const [role, counter] = process.argv.slice(2);

async function addTwenty(store: LockStore, file: string) {
	const mutex = new Mutex(store);
	for (let i = 0; i < 20; i++) {
		await mutex.acquire('counter', async () => {
			const value = Number(await readFile(file, 'utf8'));
			await writeFile(file, String(value + 1));
		});
	}
}

if (role === 'worker') {
	await addTwenty(new IpcStore(), counter!);
} else {
	const directory = await mkdtemp(join(tmpdir(), 'pool-'));
	const file = join(directory, 'counter');
	await writeFile(file, '0');

	const coordinator = new IpcLockCoordinator();
	const exits = [1, 2, 3].map(() => {
		const worker = fork(import.meta.filename, ['worker', file]);
		coordinator.adopt(worker);
		return once(worker, 'exit');
	});

	await addTwenty(coordinator, file);
	await Promise.all(exits);
	console.log('counter:', await readFile(file, 'utf8'));
	await rm(directory, { recursive: true, force: true });
}
```

Output:

```
counter: 80
```

## Why it works

The parent keeps all locks in its memory. Each worker sends its requests through the IPC channel that `fork()` made. The parent grants the key to one process at a time, first come, first served.

Each worker stops by itself when its work is done. `IpcStore` keeps the IPC channel open only while it waits for a key.

## Things to know

- **A worker that crashes** releases its keys in approximately 2 ms. The parent sees the channel close.
- **If the parent stops**, a worker that waits gets `CoordinatorUnavailableError`. A worker that holds a key keeps it. See [ADR 0004](../adr/0004-parent-stops-held-keys-stay.md).
- **Your own IPC messages** still work. Lock messages use their own envelope.
- **Only the parent's children can join.** For processes that you do not start, see [Several app instances on one host](./several-instances-on-one-host.md).
