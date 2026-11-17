# A future keeps its failure as data, and only a wait rejects

Code in many repos gives its callers the outcome of work that ends once: a value or a failure. A search on 2026-11-17 found about 17 places that write this by hand on a `Latch`, in 5 different shapes (#4519). Each keeps a `PromiseSettledResult` in the latch, as [ADR 0002](./0002-a-latch-carries-a-value-never-a-failure.md) tells, and each caller throws the error for itself. `Once` of this package is one of them.

ADR 0002 refused a latch that can carry a failure: "That is a future, and it has the danger of a promise in a field." A promise that rejects before anybody awaits it stops Node.js with an unhandled rejection. The danger is in the promise, not in the failure. A future that keeps its failure as data has no such promise.

A survey of .NET, Go, Java, Kotlin, tokio and asyncio followed #4519. Ezz then chose a set of primitives in one question. The proposal in that question named this one "Future (resolve/reject, failure kept as data so only a wait rejects; extends ADR 0002)", and Ezz answered "Lock first" for the order of the set. To the question "Which name?", with the options .NET `TaskCompletionSource`, Kotlin `CompletableDeferred` and Future, Ezz answered "Future".

## Decision

This package exports `Future<T>`. It holds a `Latch<PromiseSettledResult<T>>`. `resolve` opens the latch with a value, and `reject` opens it with a failure. `wait` reads the outcome, and throws the reason when the outcome is a failure.

```ts
import { Future } from '@zukhruf/async';

const flight = Future.run(() => work());
await flight.wait(); // Rejects here, and only here, when the work fails.
```

- **Only a wait rejects.** The failure is data in the latch. Thus a failure that nobody waits for leaves no unhandled rejection, and a class can keep a future in a field.
- **The first settle wins.** A later `resolve` or `reject` changes nothing, as a second `open` of a latch changes nothing.
- **Each wait gets the same outcome**: a wait that starts before the future settles, and a wait that starts after it.
- **A promise-typed value is refused at compile time.** `resolve` takes `T extends PromiseLike<unknown> ? never : T`, as `Latch.open` does, because a wait would adopt the promise.
- **`Future.run(work)` settles with the outcome of the work.** A work that throws at once fails the future, as a work that rejects does. `run` never throws.
- **No signal on the wait.** A caller cancels with `untilAborted(future.wait(), signal)`, as for a latch.

The name is the one of Java `CompletableFuture`, Scala `Promise` and `Future`, and Rust futures. Go has no such type.

## Considered Options

- **Keep the hand-written latch of a `PromiseSettledResult` in each place.** It is safe, but each of the 17 places writes the unwrap again, in its own shape.
- **A latch that can carry a failure**, the option that ADR 0002 refused. A `Latch` keeps the meaning "never rejects", and the failure gets its own type.
- **A future that keeps a promise from `Promise.withResolvers()`**, as most JavaScript `Deferred` helpers do. A reject with no waiter then stops the process.
- **The name `TaskCompletionSource`** of .NET. "Task" has a meaning in the mutex glossary: the mutex runs a task while a caller holds a key.
- **The name `CompletableDeferred`** of Kotlin, or `Deferred`. The glossary already lists "Deferred" as a word to avoid for a latch.

## Consequences

- `Future` and the word future are new in this package (see [CONTEXT.md](../../CONTEXT.md)). "Future" leaves the `_Avoid_` list of Latch.
- `Once` moves onto `Future`: a `WeakMap` from each check to the future of its one read.
- The other hand-written places move onto `Future` in their own steps (#4528).
