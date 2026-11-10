# Recipe: Write your own lock store

**Use case.** You need a lock store that this project does not have. For example, you want to measure how long callers wait, or you want to use a different way to hold a key.

**What you need.** The `LockStore` interface. A `Mutex` accepts any object that has these three methods:

```ts
interface LockStore {
  /** Resolves once `key` is exclusively held. Stops waiting when `signal` aborts. */
  acquire(key: string, options?: { signal?: AbortSignal }): Promise<LockHandle>;
  /** Holds `key` only if that is possible without waiting for another holder. */
  tryAcquire(key: string): Promise<LockHandle | undefined>;
  /** Whether `key` has a holder now. Never acquires the key. */
  isHeld(key: string): Promise<boolean>;
}

/** What your lock store gives the mutex: the lease and the release. */
interface LockHandle extends FencedLease, AsyncDisposable {}
```

The task gets a `FencedLease` of [`@zukhruf/fencing`](../../../fencing/README.md): a `token` and a `signal`.

## The rules

1. **Grant a key to one holder at a time.** `acquire` resolves only when no other lease for the key exists.
2. **`tryAcquire` never waits for another holder.** It returns `undefined` when the key is busy.
3. **Stop waiting when the signal aborts**, and reject with `signal.reason`. If your lock store keeps a queue that a waiter cannot leave, keep its place and pass the key on when its turn comes. The [acquire modes](../concepts/acquire-modes.md) depend on this. A caller that [cancels](../concepts/acquire-modes.md#cancel-a-wait) also depends on this: the mutex gives its signal to your lock store.
4. **Release the key in `[Symbol.asyncDispose]` of the lock handle.** Only the mutex calls it, after the task, also when the task fails. The task never gets the lock handle. Do not throw when the key is already lost: there is nothing left to release.
5. **Abort the signal when another holder may get the key.** Keep a `LeaseController` of [`@zukhruf/lease`](../../../lease/README.md) for each held key, with the key as its subject. Give its `signal` in the lock handle. Call `lose()` when another holder may get the key: the signal then aborts with a `LeaseLostError` for the key. The task can then stop, and the mutex rejects the call with `LeaseLostError`. Call `end()` when the mutex releases the key, so that a loss after the release does nothing. If your lock store never loses a key while its holder runs, give a signal that never aborts.
6. **Make the fencing token while the key is held.** Use `leaseFor(key, held, tokens)`. It calls the token source, it gives a signal that never aborts, and it releases the key if the token source fails.
7. **Let the user give a token source.** Use an option `tokens`, as the other lock stores do.
8. **Answer `isHeld` without a grant.** A [holder check](../../CONTEXT.md) reads what shows a holder. It never takes the lock that callers of `acquire` and `tryAcquire` need, and it makes no fencing token. Otherwise a holder check can make a free key busy, and a caller that skips if busy gives up. See [ADR 0015](../adr/0015-a-holder-check-never-acquires-the-key.md).

## Example 1: wrap a lock store

A decorator adds behavior to any lock store. This decorator measures the time that each caller waits.

```ts title="wait-time-store.ts"
import { setTimeout as delay } from 'node:timers/promises';

import {
  type AcquireOptions,
  type LockHandle,
  type LockStore,
  Mutex,
} from '@zukhruf/mutex';
import { MemoryStore } from '@zukhruf/mutex/memory';

/** Reports how long each caller waited for its key. */
class WaitTimeStore implements LockStore {
  readonly #inner: LockStore;
  readonly #report: (key: string, milliseconds: number) => void;

  constructor(
    inner: LockStore,
    report: (key: string, milliseconds: number) => void,
  ) {
    this.#inner = inner;
    this.#report = report;
  }

  async acquire(key: string, options?: AcquireOptions): Promise<LockHandle> {
    const started = performance.now();
    const handle = await this.#inner.acquire(key, options);
    this.#report(key, performance.now() - started);
    return handle;
  }

  tryAcquire(key: string): Promise<LockHandle | undefined> {
    return this.#inner.tryAcquire(key);
  }

  isHeld(key: string): Promise<boolean> {
    return this.#inner.isHeld(key);
  }
}

const waits: number[] = [];
const mutex = new Mutex(
  new WaitTimeStore(new MemoryStore(), (key, milliseconds) =>
    waits.push(milliseconds),
  ),
);
await Promise.all(
  [1, 2, 3].map(() => mutex.acquire('report', () => delay(50))),
);
console.log(waits.map((milliseconds) => Math.round(milliseconds / 50) * 50));
```

Output:

```
[ 0, 50, 100 ]
```

The decorator gives the lock handle of the inner lock store back without a change, and it passes the `signal` of the caller on. Thus the fencing token, the signal of the lease, the release, and the acquire modes stay correct.

## Example 2: a new way to hold a key in a directory

`FileLockStore` is the base class of the file lock stores. It changes a key into a safe file path, waits between attempts, and makes fencing tokens. You write `tryLock(path)`, one attempt, and `lock(path, signal)`, which repeats the attempt with `poll` until the key is free or the signal aborts. You also write `isHeldAt(path)`, which tells whether the key at `path` has a holder, without an attempt.

You also give `longestSuffix`: the length of the longest text that your lock store adds to `path` to name another file. `FileLockStore` gives a short name to a key that is too long for a file name with that text. If you add a longer text later, increase `longestSuffix` too. Otherwise a long key can fail with `ENAMETOOLONG`.

This lock store holds a key while a directory exists. `mkdir` fails when the directory exists, so only one process can create it. The directory is `<path>.d`, so `longestSuffix` is 2.

```ts title="directory-lock-store.ts"
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Mutex } from '@zukhruf/mutex';
import { FileLockStore } from '@zukhruf/mutex/file-system';

class DirectoryLockStore extends FileLockStore {
  protected readonly longestSuffix = '.d'.length;

  protected lock(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<AsyncDisposable> {
    return this.poll(() => this.tryLock(path), signal);
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

  /** The directory shows a holder. A check of it never creates it. */
  protected async isHeldAt(path: string): Promise<boolean> {
    return existsSync(`${path}.d`);
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
console.log({ mostActive, heldAfter: await mutex.isHeld('report') });
await rm(directory, { recursive: true, force: true });
```

Output:

```
{ mostActive: 1, heldAfter: false }
```

`poll` calls your attempt again after `pollInterval` until it returns a value, and it stops when the signal aborts. Return `undefined` when another holder has the key.

This example has no recovery: if a holder crashes, its directory stays. The stores in this project show how to add recovery. See [LockFileStore](../stores/lock-file-store.md#how-it-works).

## Test your lock store

Write the subject of your lock store in `src/testing/subjects/`. The subject tells the tests how to make a fixture, how to open a store over it, and how a child process or a worker thread opens the store. A host lock store that each process and thread opens in the same way over one directory uses `sharedByDirectory`:

```ts
// src/testing/subjects/directory-lock.ts
import { DirectoryLockStore } from '../../lock-stores/directory/directory-lock-store.ts';
import { pollInterval } from '../timing.ts';
import { sharedByDirectory } from './directory.ts';

export const openInProcess = (directory: string) =>
  new DirectoryLockStore(directory, { pollInterval });

export const { subject, sharing, threadSharing, disk } = sharedByDirectory(
  'DirectoryLockStore',
  openInProcess,
  { url: new URL(import.meta.url), export: 'openInProcess' },
  { grantLatency: 20 },
);
```

Then, beside the store, write a `<store>.contract.test.ts` that calls each contract function that the store can run:

```ts
// src/lock-stores/directory/directory-lock-store.contract.test.ts
import { durableTokens } from '../../testing/contract/durable-tokens.ts';
import { looksTakeNoToken } from '../../testing/contract/holder-check.ts';
import { lockStore } from '../../testing/contract/lock-store.ts';
import { onDisk, passiveLooks } from '../../testing/contract/on-disk.ts';
import { processes } from '../../testing/contract/processes.ts';
import { threads } from '../../testing/contract/threads.ts';
import {
  disk,
  sharing,
  subject,
  threadSharing,
} from '../../testing/subjects/directory-lock.ts';

lockStore(subject);
looksTakeNoToken(subject);
durableTokens(subject);
processes(subject, sharing);
threads(subject, threadSharing);
onDisk(subject, disk);
passiveLooks(subject, disk, sharing);
```

A call that does not compile is a capability that your store does not have. When your store does not call a function, write the reason in a comment beside the calls. Tests of the rules that only your store has go in its other test files. See [ADR 0030](../adr/0030-each-lock-store-runs-the-lock-store-contract-from-its-own-tests-and-a-capability-is-a-typed-parameter.md).
