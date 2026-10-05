# Acquire modes

A key is exclusive for every caller: one holder at a time. An **acquire mode** decides something else: what one caller does while the key is busy. Two callers of one key can use different acquire modes.

## The two acquire modes

| Acquire mode                            | While the key is busy                           | The task                      | Result type                                        |
| --------------------------------------- | ----------------------------------------------- | ----------------------------- | -------------------------------------------------- |
| `Modes.wait()` (default)                | The caller waits until the key is granted.      | Always runs.                  | The task's value                                   |
| `Modes.skipIfBusy()`                    | The caller gives up at once.                    | Does not run.                 | `{ acquired: true, value } \| { acquired: false }` |
| `Modes.skipIfBusy({ waitAtMost: 500 })` | The caller waits at most 500 ms, then gives up. | Runs only if granted in time. | `{ acquired: true, value } \| { acquired: false }` |

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

## How it works

Each lock store gives two operations:

- `acquire(key, { signal })` waits for the key, and stops waiting when `signal` aborts.
- `tryAcquire(key)` makes one attempt and never waits.

`skipIfBusy` always makes one `tryAcquire` first. Thus a free key is never skipped because of time. If the key is busy and `waitAtMost` is more than 0, it then calls `acquire` with `AbortSignal.timeout(waitAtMost)`.

**A caller that gives up keeps its place in line.** Some lock stores have a queue that a waiter cannot leave from the middle. `MemoryStore` and `TicketQueueFileStore` keep the place of a caller that gave up. When that place reaches the front, the lock store passes the key on to the next caller at once. Thus a caller that gave up never blocks the callers after it, and the order of the queue does not change.

## Write your own acquire mode

An acquire mode is a strategy object. You can write one with the two operations:

```ts
import { setTimeout as delay } from 'node:timers/promises';

import type { AcquireMode, Lease, LockStore } from '@zukhruf/mutex';

/** Tries three times, 100 ms apart. */
const tryThreeTimes: AcquireMode<'maybe'> = {
  outcome: 'maybe',
  async acquire(store: LockStore, key: string): Promise<Lease | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const lease = await store.tryAcquire(key);
      if (lease) return lease;
      await delay(100);
    }
    return undefined;
  },
};
```

Set `outcome` to `'always'` only if your mode never returns `undefined`. The result type depends on it. If a mode with the outcome `'always'` returns `undefined`, the call rejects and the task does not run.

## Evidence

- `src/mutex/acquire-modes.test.ts` runs every lock store through these cases: give up at once; acquire a free key; give up after the limit; acquire when the key is released within the limit; a caller that gave up does not block the callers after it; a key's default and an override.
- The same file tests a child process and a worker thread that give up while another process or thread holds the key. After they give up, the key is still free for the next caller.
- `src/lock-stores/remote/remote-locking.test.ts`: a grant that arrives after the caller gave up is released; a `try` during the grace window is answered `busy`; a waiter that cancels does not keep the key.
- Mutation tests: when a lock store does not pass on the place of a caller that gave up, when `tryAcquire` waits, or when `skipIfBusy` skips its first attempt, a test fails.
