# Recipe: Write your own lock store

**Use case.** You need a lock store that this project does not have. For example, you want to measure how long callers wait, or you want to use a different way to hold a key.

**What you need.** The `LockStore` interface. A `Mutex` accepts any object that has these two methods:

```ts
interface LockStore {
	/** Resolves once `key` is exclusively held. Stops waiting when `signal` aborts. */
	acquire(key: string, options?: { signal?: AbortSignal }): Promise<Lease>;
	/** Holds `key` only if that is possible without waiting for another holder. */
	tryAcquire(key: string): Promise<Lease | undefined>;
}

interface Lease extends AsyncDisposable {
	readonly token: FencingToken;
}
```

## The rules

1. **Grant a key to one holder at a time.** `acquire` resolves only when no other lease for the key exists.
2. **`tryAcquire` never waits for another holder.** It returns `undefined` when the key is busy.
3. **Stop waiting when the signal aborts**, and reject with `signal.reason`. If your lock store keeps a queue that a waiter cannot leave, keep its place and pass the key on when its turn comes. The [acquire modes](../concepts/acquire-modes.md) depend on this.
4. **Release the key in `[Symbol.asyncDispose]`.** The mutex calls it after the task, also when the task fails.
5. **Make the fencing token while the key is held.** Use `leaseFor(key, held, tokens)`. It calls the token source, and it releases the key if the token source fails.
6. **Let the user give a token source.** Use an option `tokens`, as the other lock stores do.

## Example 1: wrap a lock store

A decorator adds behavior to any lock store. This decorator measures the time that each caller waits.

```ts title="wait-time-store.ts"
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryStore, Mutex, type AcquireOptions, type Lease, type LockStore } from '@zukhruf/mutex';

/** Reports how long each caller waited for its key. */
class WaitTimeStore implements LockStore {
	readonly #inner: LockStore;
	readonly #report: (key: string, milliseconds: number) => void;

	constructor(inner: LockStore, report: (key: string, milliseconds: number) => void) {
		this.#inner = inner;
		this.#report = report;
	}

	async acquire(key: string, options?: AcquireOptions): Promise<Lease> {
		const started = performance.now();
		const lease = await this.#inner.acquire(key, options);
		this.#report(key, performance.now() - started);
		return lease;
	}

	tryAcquire(key: string): Promise<Lease | undefined> {
		return this.#inner.tryAcquire(key);
	}
}

const waits: number[] = [];
const mutex = new Mutex(
	new WaitTimeStore(new MemoryStore(), (key, milliseconds) => waits.push(milliseconds)),
);
await Promise.all([1, 2, 3].map(() => mutex.acquire('report', () => delay(50))));
console.log(waits.map((milliseconds) => Math.round(milliseconds / 50) * 50));
```

Output:

```
[ 0, 50, 100 ]
```

The decorator gives the lease of the inner lock store back without a change, and it passes the `signal` on. Thus the fencing token, the release, and the acquire modes stay correct.

## Example 2: a new way to hold a key in a directory

`FileLockStore` is the base class of the file lock stores. It changes a key into a safe file path, waits between attempts, and makes fencing tokens. You write `tryLock(path)`, one attempt, and `lock(path, signal)`, which repeats the attempt with `poll` until the key is free or the signal aborts.

This lock store holds a key while a directory exists. `mkdir` fails when the directory exists, so only one process can create it.

```ts title="directory-lock-store.ts"
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FileLockStore, Mutex } from '@zukhruf/mutex';

class DirectoryLockStore extends FileLockStore {
	protected lock(path: string, signal: AbortSignal | undefined): Promise<AsyncDisposable> {
		return this.poll(() => this.tryLock(path), { signal });
	}

	protected async tryLock(path: string): Promise<AsyncDisposable | undefined> {
		const held = `${path}.d`;
		try {
			await mkdir(held);
			return { [Symbol.asyncDispose]: () => rmdir(held) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
			throw error;
		}
	}
}

const directory = await mkdtemp(join(tmpdir(), 'directory-lock-'));
const mutex = new Mutex(new DirectoryLockStore(directory));
let active = 0;
let mostActive = 0;
await Promise.all(
	[1, 2, 3].map(() =>
		mutex.acquire('report', async () => {
			mostActive = Math.max(mostActive, ++active);
			await delay(20);
			active--;
		}),
	),
);
console.log({ mostActive });
await rm(directory, { recursive: true, force: true });
```

Output:

```
{ mostActive: 1 }
```

`poll` calls your attempt again after `pollInterval` until it returns a value, and it stops when the signal aborts. Return `undefined` when another holder has the key.

This example has no recovery: if a holder crashes, its directory stays. The stores in this project show how to add recovery. See [LockFileStore](../stores/lock-file-store.md#how-it-works).

## Test your lock store

Add your lock store to `src/testing/store-cases.ts`. Then all tests of the matrix run against it: the single-process tests, and the cross-process tests if its reach is a host or a process tree.

```ts
{
	name: 'DirectoryLockStore',
	reach: 'host',
	durableTokens: true,
	...sharedByDirectory((directory) => new DirectoryLockStore(directory, { pollInterval })),
},
```
