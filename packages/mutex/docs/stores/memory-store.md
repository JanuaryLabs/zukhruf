# MemoryStore

The simplest lock store. It keeps the locks in the memory of one object.

| Reach    | Order                    | Holder process stops   | Default token source |
| -------- | ------------------------ | ---------------------- | -------------------- |
| Instance | First come, first served | The locks stop with it | `CounterTokenSource` |

## What

`MemoryStore` keeps one line for each key in a `Map`, on a `Lock` of `@zukhruf/async`. A waiter waits for the callers before it. Only callers that use the same `MemoryStore` object share its locks.

```ts
import { Mutex } from '@zukhruf/mutex';
import { MemoryStore } from '@zukhruf/mutex/memory';

const mutex = new Mutex(new MemoryStore());
const reserved = await mutex.acquire('product:42', async () =>
  reserveOneItem(),
);
```

## Why

Most race conditions occur inside one process. For example, two HTTP requests read the stock before one of them writes it. `MemoryStore` stops this with no files, no other process, and no delay. It grants a free key before the next event loop turn.

## When

- One process does all the writes to the resource.
- You want the fastest lock store.
- You want a first-come, first-served order.

## When not

- More than one process writes to the resource. Each process gets its own `MemoryStore`, so the processes do not share locks. See [reach](../concepts/reach.md).
- Worker threads share the resource. Use [ThreadStore](./thread-store.md).

## How it works

Each key has a line: a `Lock` of `@zukhruf/async` and a count of its callers. The lock grants the key to the callers in the order of their calls. When the mutex releases the key, the lock gives it to the next caller in the line. A caller that gives up or cancels leaves the line at once, and the caller behind it moves up. It never gets the key early: it still waits for the callers before it. When the last caller leaves the line, `MemoryStore` removes the key from the map, in the same turn as the release. See [ADR 0032](../adr/0032-a-cancelled-waiter-of-the-memory-store-leaves-the-line.md).

A task that fails does not stop the queue. The next waiter gets the key, and the caller of the failed task gets the error.

## Acquire modes

`tryAcquire` takes the key only when nobody holds it or waits for it, and grants a free key before the next event loop turn. A caller that gives up leaves the line, so it costs the callers behind it no turn. See [acquire modes](../concepts/acquire-modes.md).

## Holder check

`isHeld(key)` reads the line of the key. The first caller in the line holds the key, so a key with a line has a holder. A holder check does not join the line. See [ADR 0015](../adr/0015-a-holder-check-never-acquires-the-key.md).

`holdsAnyKey` is `true` while a caller holds any key. A caller waits only behind a holder, so `false` also tells that nobody waits. The socket lock store reads it to decide on a clean shutdown ([ADR 0018](../adr/0018-the-next-leader-skips-the-grace-window-after-a-clean-shutdown.md)).

## Failure modes

The locks are in memory, so they stop with the process. No other process can wait for them. See [failure modes](../concepts/failure-modes.md).

## Options

| Option   | Default                    | Description                                                                                                      |
| -------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `tokens` | `new CounterTokenSource()` | The token source. The default starts at 1 in each process. For a durable fenced resource, use `FileTokenSource`. |

The token sources come from `@zukhruf/fencing`, for example `import { FileTokenSource } from '@zukhruf/fencing'`.

## Evidence

`src/lock-stores/memory/memory-store.contract.test.ts` runs the single-process tests of the lock-store contract against `MemoryStore`:

- A waiter does not start before the holder finishes.
- Three concurrent requests run one at a time, and each gets its own result.
- A failed task gives its error to its caller, and the next waiter still runs.
- Keys such as `constructor` and `__proto__` work as normal keys.

`src/lock-stores/memory/memory-store-cancel.test.ts` shows that a caller that cancels leaves the line:

- A key whose only waiter cancelled is free in the same turn that its holder releases it.
- The release gives the key to the waiter behind the cancelled one, not to a newcomer.
- The waiters get the key in the order in which they came.
