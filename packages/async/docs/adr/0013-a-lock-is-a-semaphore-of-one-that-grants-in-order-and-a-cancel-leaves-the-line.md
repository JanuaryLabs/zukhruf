# A lock is a semaphore of one that grants in order, and a cancel leaves the line

Code in many repos lets one caller at a time do a thing, in the order in which the callers came. A search on 2026-11-17 found 14 places that write this by hand (#4519). Most keep a promise tail: each caller waits for the tail, then puts its own work at the end of it. Three of them (`collect.ts` of finetuning, and `grant-opener.ts` of elt and of text2sql) stop for good after one failed write, because the tail then rejects for each later caller. theagentlab built two of its tails on a `Latch` that opens at once, and #4519 first asked for a latch that starts open.

Ezz refused that request: "it is not both or whatnot. go back. find the proper pattern. learn from other languages and let us refactor to have this built in good manner. every package here built to be changed and extended." A survey of .NET, Go, Java, Kotlin, tokio and asyncio followed. In it, a caller that runs one at a time takes a lock, and the lock grants in order. Ezz then chose, in the words of his answers: "Lock first", "Own Lock" (not `worker_threads.locks.request`), and "Lock.run(work) beside acquire(), Semaphore public now, MemoryStore moves onto Lock".

## Decision

This package exports `Semaphore` and `Lock`. A `Semaphore` has a count of permits. A caller that finds a free permit holds it at once; a caller that finds none waits in a line. A `Lock` holds a `Semaphore` of one permit, as tokio's `Mutex` holds a `batch_semaphore` and Kotlin's `MutexImpl` extends `SemaphoreImpl(1)` (both recalled from their source, not read again for this ADR).

```ts
import { Lock } from '@zukhruf/async';

const writes = new Lock();
await writes.run(() => write(state), { signal });

using held = await writes.acquire({ signal });
```

- **The permits go to the line in order.** A dispose gives the permit to the first waiter at once, so a later `tryAcquire` or `acquire` never takes it first. The async locks of the survey grant in order: tokio `Mutex` and `Semaphore`, Kotlin `Mutex`, asyncio `Lock`, Go `semaphore.Weighted`, and `AsyncLock` of AsyncEx (recalled from their docs, not read again for this ADR).
- **A cancel leaves the line.** When the signal aborts during the wait, the caller leaves the line, and the acquire rejects with the reason of the signal. The next waiter then moves up. When the signal aborted before the call, the caller takes no permit, also when one is free. When the turn of a caller comes in the same step as its cancel, the cancel wins and the permit passes on to the next waiter.
- **A permit is a `Disposable`.** A dispose gives the permit back, and a second dispose of one permit gives back nothing. `using` disposes it at the end of the block.
- **`Lock.run(work)` holds the lock while the work runs**, and frees it when the work ends, also when the work fails. A failed run thus never stops the callers after it, as the promise tails did.
- **No clock.** A time limit is a signal: `timeout(ms, { clock }).signal`.
- The constructor refuses a count of permits that is not a positive integer with a `RangeError`.

## Considered Options

- **A latch that starts open**, the first ask of #4519. Two of the three open latches of theagentlab run work in order, and that is a lock. The third waits until a count of commands is zero, and that is a wait group (#4527). A latch keeps starting closed.
- **`navigator.locks` or `worker_threads.locks.request`.** On Node.js 26.13 they grant in order within one thread, and they take a signal. But a lock name is global to the process, so a lock for one object needs a name from `randomUUID`. The request gives no `using` handle, only a callback, and it has no form with many permits. [ADR 0005 of `@zukhruf/mutex`](../../../mutex/docs/adr/0005-threads-use-a-coordinator-not-web-locks.md) records that they give one exclusive lock to two worker threads at the same time.
- **A cancelled waiter keeps its place**, as `MemoryStore` of `@zukhruf/mutex` does: its place passes the key on when its turn comes. Each cancelled waiter then still costs one turn. A semaphore owns its line, so a cancel can take the caller out of it.
- **No order**, as .NET `SemaphoreSlim` and Go `sync.Mutex` in its normal mode have. A caller can then wait without end while later callers take the lock, and the hand-written places all keep the order.
- **A `Lock` and a `Semaphore` with no shared code.** The rules of the line (order, cancel, dispose) are the same for one permit and for many, so they have one home.

## Consequences

- `Semaphore`, `Lock`, `AcquireOptions` and the words permit, line and holder are new in this package (see [CONTEXT.md](../../CONTEXT.md)).
- The next step (#4525) moves the three tails that stop after a failed write onto `Lock.run`. `MemoryStore` moves onto `Lock` in its own step (#4529).
- A lock is not reentrant: a holder that acquires again waits for itself. No hand-written place needs reentry.
