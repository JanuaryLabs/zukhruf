# A wait group counts disposable tokens, and may count up again after zero

Code in many repos waits until the work in flight is done, and then starts new work. A search on 2026-11-17 found 6 places that write this by hand (#4519): the supervisor of theagentlab (`#idle` and `#activeCommands`), `pool-workers.ts` of `@zukhruf/pool`, `wakes.ts` of `@zukhruf/sqlite-notify`, `index.ts` of `@zukhruf/sqlite-queue`, the server plugin of context-compiler, and `transcription.ts`. Each keeps a count and a latch, and puts a new latch in its place when the count reaches zero. `#idle` of theagentlab was one of the three latches that #4519 first asked to start open. [ADR 0013](./0013-a-lock-is-a-semaphore-of-one-that-grants-in-order-and-a-cancel-leaves-the-line.md) found that it is a wait group, not a latch.

A survey of .NET, Go, Java, Kotlin, tokio and asyncio followed #4519. Ezz then chose a set of primitives in one question. The proposal in that question named this one "WaitGroup (add() returns a Disposable, wait(), countable again after zero, as Go allows)", and Ezz answered "Lock first" for the order of the set.

## Decision

This package exports `WaitGroup`. `add()` gives a token, a `Disposable`, and the wait group counts the token until a dispose. `wait({ signal })` ends at once when the count is zero, else when the count next reaches zero.

```ts
import { WaitGroup } from '@zukhruf/async';

const commands = new WaitGroup();
using _command = commands.add();
await commands.wait({ signal });
```

- **The count can go up again after zero**, as a Go `sync.WaitGroup` can. tokio_util `TaskTracker` and AsyncEx `AsyncCountdownEvent` can also serve again after they reached zero (recalled from their docs, not read again for this ADR). Each place of the search starts new work after a zero.
- **A wait ends at the next zero.** The wait group holds a latch until the count reaches zero. When the count reaches zero, it opens that latch and puts a new latch in its place. Thus a wait that started before the zero ends, also when an `add` follows the zero in the same step, and a wait after that `add` waits for the new work.
- **A token is a `Disposable`**, as a permit of a `Semaphore` is. A second dispose of one token changes nothing, so a count can never go below zero. Go panics on a negative count; a token cannot make one. `using` disposes the token at the end of the block, also when the work fails.
- **A wait takes a signal**, as `Semaphore.acquire` does. Its options type is `WaitOptions`, in the shape of `AcquireOptions`. A cancel rejects the wait with the reason of the signal, and removes its listener. A signal that aborted before the call rejects at once, also at zero. A cancel does not change the count.
- **No clock.** A time limit is a signal: `timeout(ms, { clock }).signal`.

## Considered Options

- **A countdown that cannot count up after zero**, as Java `CountDownLatch` and .NET `CountdownEvent` (whose `AddCount` throws once the count is zero). Each place of the search counts up again after a zero, so each would make a new countdown after each zero, which is the hand-written code of today.
- **`add(n)` and `done()`, as in Go.** A `done` that is called twice counts down twice, and a count below zero is an error that only a run finds. A token counts once.
- **A `go(work)` method beside `add`**, as Go 1.25 `WaitGroup.Go` and `TaskTracker::spawn` have. `using _work = group.add()` already frees the token when the work ends or fails. No place of the search needs more.
- **A wait with no signal**, as a latch and a future have. A wait group waits at shutdown, and a shutdown has a time limit, so the wait takes the signal as `Semaphore.acquire` does.

## Consequences

- `WaitGroup`, `WaitOptions` and the words wait group and token are new in this package (see [CONTEXT.md](../../CONTEXT.md)). The glossary says that a token of a wait group is not a fencing token of `@zukhruf/mutex`.
- The 6 hand-written places move onto `WaitGroup` in their own steps (#4528).
- A cancelled wait leaves its callback on the latch until the count reaches zero, as `untilAborted(latch.wait(), signal)` does for a latch. A long time above zero with many cancelled waits keeps them all until the zero.
