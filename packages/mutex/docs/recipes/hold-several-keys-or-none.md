# Recipe: Hold several keys for one run, or skip the run

**Use case.** One run copies several tables, and each copy has its own key. The run must hold all its keys before it works. When another run holds one of them, the run must skip, and it must not keep the keys that it already holds. If it keeps them, it blocks other runs that need only those keys. elt's `SQLiteCheckpointStore` does this with one key for each copy ID (elt's `packages/destinations/sqlite/docs/adr/0005-each-checkpointed-copy-has-its-own-lock.md`, elt commit `229349b2`).

**Lock store.** Any lock store works. This program uses `MemoryStore`. For runs in several processes, use a host lock store such as `SqliteStore`, as elt does.

## The steps

1. Acquire the first key with `Modes.skipIfBusy()`.
2. In the task of that acquire, acquire the next key in the same way. Continue until the run holds all keys.
3. Do the work in the task of the last acquire.
4. When an acquire gives up, return `{ acquired: false }` from its task. Each acquire around it then ends, and the mutex releases its key.

## The program

Another run holds `copy:b`. A first run asks for `copy:a`, `copy:b` and `copy:c`, and skips. A second run asks for `copy:a` and `copy:c`, and works. When `copy:b` is free, a third run holds all three keys.

```ts title="hold-several-keys.ts"
import { Modes, Mutex } from '@zukhruf/mutex';
import { MemoryStore } from '@zukhruf/mutex/memory';

type Held<T> = { acquired: true; value: T } | { acquired: false; busy: string };

// Holds the first key, and inside its task the rest of the keys, then works.
// When one key is busy, each acquire around it ends, and releases its key.
async function holdAll<T>(
  mutex: Mutex,
  keys: readonly string[],
  work: () => Promise<T>,
): Promise<Held<T>> {
  const [key, ...rest] = keys;
  if (key === undefined) return { acquired: true, value: await work() };
  const held = await mutex.acquire(key, () => holdAll(mutex, rest, work), {
    mode: Modes.skipIfBusy(),
  });
  return held.acquired ? held.value : { acquired: false, busy: key };
}

const mutex = new Mutex(new MemoryStore());

// Another run holds copy:b until it is told to stop.
const { promise: stop, resolve: release } = Promise.withResolvers<void>();
const other = mutex.acquire('copy:b', () => stop);
while (!(await mutex.isHeld('copy:b'))) await Promise.resolve();

const first = await holdAll(mutex, ['copy:a', 'copy:b', 'copy:c'], async () =>
  console.log('first run works'),
);
console.log('first run:', first);
console.log('copy:a held after it:', await mutex.isHeld('copy:a'));

const second = await holdAll(mutex, ['copy:a', 'copy:c'], async () => 'done');
console.log('second run:', second);

release();
await other;

const third = await holdAll(mutex, ['copy:a', 'copy:b', 'copy:c'], async () => {
  const held = await Promise.all(
    ['copy:a', 'copy:b', 'copy:c'].map((key) => mutex.isHeld(key)),
  );
  return `held while it works: ${held.join(', ')}`;
});
console.log('third run:', third);
```

Output:

```
first run: { acquired: false, busy: 'copy:b' }
copy:a held after it: false
second run: { acquired: true, value: 'done' }
third run: { acquired: true, value: 'held while it works: true, true, true' }
```

## Why it works

Each acquire of `Mutex` holds its key only while its task runs, and releases the key when the task ends (`await using` in `src/mutex/mutex.ts`). `holdAll` puts the acquire of each next key in the task of the key before it. Thus the acquires make a stack. When the acquire of `copy:b` gives up, it returns `{ acquired: false }`. The task of `copy:a` then ends, and the mutex releases `copy:a`. The first run never prints "first run works", and `copy:a` has no holder after it.

The second run does not ask for `copy:b`, so the other holder does not stop it. Runs with different keys run in parallel.

`Modes.skipIfBusy()` with no options makes one attempt only (`src/mutex/acquire-modes/skip-if-busy-mode.ts`). A run never waits for a key while it holds another key.

## Things to know

- **Do not use `Modes.wait()` for the inner keys.** A run that waits for a key while it holds another key can deadlock with a run that asks for the same keys in a different order. With `Modes.skipIfBusy()`, one of the two runs skips. Both runs can skip, and neither works. To make this less frequent, give the keys to each run in the same order, for example sorted.
- **To fail the run in place of a skip, throw in the task.** `SQLiteCheckpointStore` throws `Checkpoint <id> is in use by another run` when a key is busy (`packages/destinations/sqlite/src/sqlite-checkpoint-store.ts`, lines 42-53, in elt). The error goes through each task around it, and the mutex releases each key on the way out, as it does for a return.
- **The work gets no lease.** `holdAll` gives the work no fencing token and no signal. When the lock store may grant one of the keys to another holder, the acquire of that key rejects after its task ends (`src/mutex/mutex.ts`). To stop the work early, pass the signal of each lease down, and join them with `AbortSignal.any`.
- **Each key costs one acquire.** With `SqliteStore`, each acquire writes a durable fencing token. elt measured about 9 ms for each key (elt-sqlite ADR 0005).
- **elt's SQL Server destination takes the same design.** Its `SqlServerCheckpointStore` is to hold one key of `SqlServerStore` for each copy ID, and to skip a key that is busy (elt's `packages/destinations/sqlserver/docs/adr/0009-each-lock-is-an-application-lock-of-sql-server.md`, accepted 2026-11-19).
- **Skip one key with `Modes.skipIfBusy()`.** See [Skip a job that is already running](./skip-a-job-that-is-already-running.md).
