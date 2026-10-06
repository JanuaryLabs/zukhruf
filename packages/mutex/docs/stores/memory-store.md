# MemoryStore

The simplest lock store. It keeps the locks in the memory of one object.

| Reach    | Order                    | Holder process stops   | Default token source |
| -------- | ------------------------ | ---------------------- | -------------------- |
| Instance | First come, first served | The locks stop with it | `CounterTokenSource` |

## What

`MemoryStore` keeps one queue for each key in a `Map`. A waiter waits for the holder before it. Only callers that use the same `MemoryStore` object share its locks.

```ts
import { MemoryStore, Mutex } from '@zukhruf/mutex';

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

Each key has a queue. Each caller that joins the queue gets a one-shot latch: a gate that opens once and never closes again. The caller opens its latch when it releases the key. The next caller waits for that latch, so it gets the key only after the caller before it. A caller that gives up opens its latch when its turn comes, so the caller behind it never gets the key early. When the last caller in the queue releases the key, `MemoryStore` removes the key from the map.

A task that fails does not stop the queue. The next waiter gets the key, and the caller of the failed task gets the error.

## Acquire modes

`tryAcquire` checks whether the key has a queue, and grants a free key before the next event loop turn. A caller that gives up keeps its place in the queue. When its place reaches the front, the key passes on to the next caller at once. See [acquire modes](../concepts/acquire-modes.md).

## Failure modes

The locks are in memory, so they stop with the process. No other process can wait for them. See [failure modes](../concepts/failure-modes.md).

## Options

| Option   | Default                    | Description                                                                                                      |
| -------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `tokens` | `new CounterTokenSource()` | The token source. The default starts at 1 in each process. For a durable fenced resource, use `FileTokenSource`. |

## Evidence

The single-process tests in `src/mutex/mutex.test.ts` run against `MemoryStore`:

- A waiter does not start before the holder finishes.
- Three concurrent requests run one at a time, and each gets its own result.
- A failed task gives its error to its caller, and the next waiter still runs.
- Keys such as `constructor` and `__proto__` work as normal keys.
