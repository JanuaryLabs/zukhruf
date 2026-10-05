# Recipe: Several app instances on one host

**Use case.** A process manager (for example PM2 or systemd) runs three copies of your app on one machine. All copies write to the same file or database. Only one copy at a time must do the write.

**Lock store.** A host lock store. Each copy creates it with the **same directory**.

## Select a lock store

| You want | Use |
|---|---|
| No cleanup after a crash, and no server | [SqliteStore](../stores/sqlite-store.md) |
| First come, first served, and only files | [TicketQueueFileStore](../stores/ticket-queue-file-store.md) |
| The next waiter gets the key at once | [SocketStore](../stores/socket-store.md) |
| To see the holders with `ls` and `cat` | [LockFileStore](../stores/lock-file-store.md) |

If you are not sure, start with `SqliteStore`. You can change the lock store later. The code changes in one line.

## The program

This program starts three copies of itself. Each copy adds 1 to a counter file 20 times. To add 1, a copy reads the file and then writes it. Without a shared lock, two copies can read the same value, and an increment is lost.

```ts title="instances.ts"
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mutex, SqliteStore } from '@zukhruf/mutex';

const [role, shared] = process.argv.slice(2);

if (role === 'instance') {
	// One copy of the app. All copies use the same directory for their locks.
	const mutex = new Mutex(new SqliteStore(join(shared!, 'locks')));
	const counter = join(shared!, 'counter');
	for (let i = 0; i < 20; i++) {
		await mutex.acquire('counter', async () => {
			const value = Number(await readFile(counter, 'utf8'));
			await writeFile(counter, String(value + 1));
		});
	}
} else {
	const directory = await mkdtemp(join(tmpdir(), 'instances-'));
	await writeFile(join(directory, 'counter'), '0');
	const exits = [1, 2, 3].map(() =>
		once(fork(import.meta.filename, ['instance', directory]), 'exit'),
	);
	await Promise.all(exits);
	console.log('counter:', await readFile(join(directory, 'counter'), 'utf8'));
	await rm(directory, { recursive: true, force: true });
}
```

Output:

```
counter: 60
```

To use another lock store, change one line. For example: `new TicketQueueFileStore(join(shared!, 'locks'))`.

## Why it works

All copies give the same directory to the lock store. The lock store keeps the lock for the key `counter` in that directory. Thus all copies ask the same lock store, and only one copy at a time reads and writes the counter.

## Things to know

- **Use the same path in each copy.** A different path is a different lock.
- **Use a local directory**, not a network file system.
- **Use durable tokens with a durable resource.** The file lock stores and `SqliteStore` already do this. See [fencing tokens](../concepts/fencing-tokens.md).
- If a copy crashes while it holds a key, see [Survive a crashed holder](./survive-a-crashed-holder.md).
