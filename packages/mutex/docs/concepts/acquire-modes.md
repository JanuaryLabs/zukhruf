# Acquire modes

A key is exclusive for every caller: one holder at a time. An **acquire mode** decides something else: what one caller does while the key is busy. Two callers of one key can use different acquire modes.

## The two acquire modes

| Acquire mode                            | While the key is busy                                          | The task                      | Result type                                        |
| --------------------------------------- | -------------------------------------------------------------- | ----------------------------- | -------------------------------------------------- |
| `Modes.wait()` (default)                | The caller waits until the key is granted.                     | Always runs.                  | The task's value                                   |
| `Modes.skipIfBusy()`                    | The caller gives up at once.                                   | Does not run.                 | `{ acquired: true, value } \| { acquired: false }` |
| `Modes.skipIfBusy({ waitAtMost: 500 })` | The caller waits at most 500 ms for the holder, then gives up. | Runs only if granted in time. | `{ acquired: true, value } \| { acquired: false }` |

```ts
import { Modes, Mutex, SqliteStore } from '@zukhruf/mutex';

const mutex = new Mutex(new SqliteStore('/var/lib/my-app/locks'));

// Wait (the default): the result is the task's value.
const sold: boolean = await mutex.acquire('product:42', async () => reserve());

// Skip if busy: check `acquired` before you read `value`.
const result = await mutex.acquire('report:daily', async () => buildReport(), {
  mode: Modes.skipIfBusy(),
});
if (result.acquired) console.log(result.value);
```

TypeScript stops you from reading `value` before you check `acquired`. A caller that can give up must handle "not acquired".

## A default for each key

Most keys have one kind of caller. Give the key a default acquire mode, and let one call override it:

```ts
const report = mutex.key('report:daily', { mode: Modes.skipIfBusy() });

await report.run(task); // The cron job skips if a report runs.
await report.run(task, { mode: Modes.wait() }); // The admin button waits and then runs.
```

## Why two callers of one key can use different modes

The cron job and the admin button above protect the same report, so they need the same key. But they need different reactions to "busy": the cron job must not queue 60 runs, and the admin must get a real run. The acquire mode changes only the reaction of one caller. A caller that skips never becomes a holder, so it cannot change exclusivity.

## Cancel a wait

A caller can stop its own wait with an `AbortSignal`. Give the signal to one call, with or without an acquire mode:

```ts
// An HTTP handler: a client that leaves does not reserve an item.
const sold = await mutex.acquire('product:42', async () => reserve(), {
  signal: request.signal,
});

await report.run(task, { mode: Modes.wait(), signal });
```

When the signal aborts, the caller **cancels**. The call rejects with `signal.reason`, and the task does not run. A cancel is not the same as an acquire mode that gives up:

| What happens | Who decides                                              | The result                            |
| ------------ | -------------------------------------------------------- | ------------------------------------- |
| Give up      | The acquire mode, for example at the end of `waitAtMost` | `{ acquired: false }`                 |
| Cancel       | The caller, with its own signal                          | The call rejects with `signal.reason` |

The rules:

- **A cancel works with each acquire mode**, also with an acquire mode that you write. The mutex makes sure of this. It does not depend on the acquire mode.
- **A caller that cancelled before the call does not acquire the key**, also when the key is free.
- **If the lock store grants the key after the cancel, the mutex releases the key at once.** The next waiter then gets it.
- **A cancel stops only the wait.** When the caller holds the key, the task runs to its end. If the task must stop too, give the signal to the task.
- **A key does not keep a signal.** A key lives longer than one call, and a signal is for one call. Give the signal to `run`.

## How it works

Each lock store gives two operations:

- `acquire(key, { signal })` waits for the key, and stops waiting when `signal` aborts.
- `tryAcquire(key)` makes one attempt and never waits.

`skipIfBusy` always makes one `tryAcquire` first. Thus a free key is never skipped because of time. If the key is busy and `waitAtMost` is more than 0, it then calls `acquire` with one signal. This signal aborts at the end of `waitAtMost` or when the caller cancels (`AbortSignal.any`). Only the end of `waitAtMost` makes `skipIfBusy` give up.

**The time limit counts only the wait for another holder.** It starts when the lock store answers that the key is busy. A lock store with a coordinator can take longer to answer, for example while it connects, while a campaign runs, or while the leader is frozen. That time does not count, because a slow answer does not show that the key is busy. If `skipIfBusy` gave up then, `{ acquired: false }` would tell of a holder that maybe does not exist. To limit the total time of a call, also give a signal, for example `AbortSignal.timeout(2000)`. When that signal aborts, the call rejects. It does not give up. See [Cancel a wait](#cancel-a-wait) and [ADR 0010](../adr/0010-the-time-limit-of-skip-if-busy-counts-only-the-wait-for-a-holder.md).

The mutex gives the caller's signal to the acquire mode, and the acquire mode gives it to the lock store. Thus the lock store stops the wait at once. The mutex also watches the signal itself. Thus an acquire mode that does not give the signal on cannot make a caller that cancelled wait.

**A caller that gives up or cancels keeps its place in line.** Some lock stores have a queue that a waiter cannot leave from the middle. `MemoryStore` and `TicketQueueFileStore` keep the place of a caller that stopped its wait. When that place reaches the front, the lock store passes the key on to the next caller at once. Thus a caller that stopped its wait never blocks the callers after it, and the order of the queue does not change.

## Write your own acquire mode

An acquire mode is a strategy object. You can write one with the two operations:

```ts
import { setTimeout as delay } from 'node:timers/promises';

import type {
  AcquireMode,
  AcquireOptions,
  Lease,
  LockStore,
} from '@zukhruf/mutex';

/** Tries three times, 100 ms apart. */
const tryThreeTimes: AcquireMode<'maybe'> = {
  outcome: 'maybe',
  async acquire(
    store: LockStore,
    key: string,
    { signal }: AcquireOptions,
  ): Promise<Lease | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const lease = await store.tryAcquire(key);
      if (lease) return lease;
      await delay(100, undefined, { signal });
    }
    return undefined;
  },
};
```

Set `outcome` to `'always'` only if your mode never returns `undefined`. The result type depends on it. If a mode with the outcome `'always'` returns `undefined`, the call rejects and the task does not run.

Give `signal` to each wait in your mode. Then a cancel stops your mode at once. If you do not, the mutex still rejects the call at once. But your mode continues until it ends, and the mutex then releases the key that it got.

## Evidence

- `src/mutex/acquire-modes.test.ts` runs every lock store through these cases: give up at once; acquire a free key; give up after the limit; acquire when the key is released within the limit; a caller that gave up does not block the callers after it; a key's default and an override.
- The same file runs every lock store through these cases for a cancel: a waiter that cancels rejects with the reason, and the callers after it still get the key; `skipIfBusy({ waitAtMost })` rejects when its caller cancels; it still gives up when the signal does not abort; a caller that cancelled before the call rejects in each mode and leaves a free key free; one signal for many calls keeps no listeners.
- With a lock store whose first answer comes after the limit: `skipIfBusy({ waitAtMost })` still acquires a free key, because a slow answer is not a busy key.
- With `MemoryStore`: a key gives one call's signal on; each built-in mode gives the signal to the lock store; a mode that does not give the signal on still rejects at once, and the mutex releases the key that it gets later; a cancel during the first attempt of `skipIfBusy` releases the key of that attempt; a cancel after the task started does not stop the task.
- The same file tests a child process and a worker thread that give up, and then cancel a wait, while another process or thread holds the key. After that, the key is still free for the next caller.
- `src/lock-stores/remote/remote-locking.test.ts`: a grant that arrives after the caller gave up is released; a `try` during the grace window is answered `busy`; a waiter that cancels does not keep the key.
- Mutation tests: when a lock store does not pass on the place of a caller that gave up, when `tryAcquire` waits, or when `skipIfBusy` skips its first attempt, a test fails. A test also fails when the mutex does not check a signal before the call, does not watch the signal, or does not release a key that comes after a cancel; when a built-in mode does not give the signal to the lock store; or when a key does not give the signal on.
