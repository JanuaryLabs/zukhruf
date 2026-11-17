# A cond wakes the waits that started before a broadcast, and keeps nothing for a later wait

Code in many repos waits until a state changes, and then checks the state again. A search on 2026-11-17 found 5 places that write "wake every caller that waits now, and keep nothing" by hand (#4547):

- `web-scan.ts` of elt (`packages/sources/web/pages/src/web-scan.ts:66-90`): a `Delivery` that swaps a `Latch` at each arrival, and loops on `give()`/`end()` and `ended()`/`take()`.
- `pipeline.ts` of elt (near lines 283 and 451): a watch loop that an abort, three state changes and a retry timer wake.
- `pool-workers.ts` of `@zukhruf/pool` (near lines 109-139): a rest that an event resets by hand at line 139.
- `engine-proxy.ts` of `@zukhruf/testing` (line 127): `while (#unanswered > 0) await once(#answers, 'answered')`.
- `sse.ts` of sdk-it (`packages/runtime/src/http/sse.ts:76-81`), which text2sql `packages/client` and the websets client of context-compiler generate from.

Each place checks its state, waits for a wake, and checks again. No place passes a value with the wake, and no place wakes only one caller.

The proposal (session mutex-fb, recorded in #4547) was a `Cond` whose `wait({ signal })` registers at the call and whose `broadcast()` wakes the waits that started before it and keeps nothing. Ezz answered "Cond, as proposed (Recommended)" on 2026-11-17.

## Decision

This package exports `Cond`. `wait({ signal })` ends at the first broadcast after the call. `broadcast()` ends each wait that started before it, and keeps nothing for a later wait.

```ts
import { Cond } from '@zukhruf/async';

const changed = new Cond();
while (queue.length === 0) await changed.wait({ signal });
```

- **A wait registers in the step of the call.** A wait that starts just before a broadcast, in the same step, ends at that broadcast. Thus a caller that checks its state and then waits, with no `await` between them, cannot miss a broadcast.
- **A broadcast keeps nothing.** A wait that starts after a broadcast waits for the next one. A cond has no state that stays set.
- **A cond holds a latch**, and a broadcast opens it and puts a new latch in its place, as a wait group does at each zero ([ADR 0015](./0015-a-wait-group-counts-disposable-tokens-and-may-count-up-again-after-zero.md)).
- **A wait takes a signal.** Its options type is `WaitOptions`, the one of `WaitGroup.wait`. A cancel rejects the wait with the reason of the signal and removes its listener. A signal that aborted before the call rejects at once.
- **No value, no clock.** A woken caller reads the state that changed. A time limit is a signal: `timeout(ms, { clock }).signal`.
- **The name is the one of Go `sync.Cond`.** tokio `Notify` keeps a permit for a later wait after `notify_one`. A condition (Python `asyncio.Condition`, Java `Condition`) holds a lock. An event (.NET `ManualResetEvent`, `asyncio.Event`) stays set. These facts are recalled from their docs, not read again for this ADR.

**A deviation from Go: a cond has no lock.** Go `sync.Cond` takes a `Locker`, and `Wait` unlocks it and adds the caller to the list in one step, so no `Broadcast` can come between the check of the state and the wait. In JavaScript, one thread runs the code between two `await`s, and `wait` adds the caller in the step of the call. That step does the job of Go's lock. A caller that must hold a lock across an `await` takes a `Lock` of this package.

## Considered Options

- **A lock parameter, as Go `sync.Cond` takes.** The registration in the step of the call already closes the gap that the lock closes in Go. No place of the search holds a lock around its check.
- **`signal()` or `notify_one`, to wake one caller.** No place of the search wakes one caller. In tokio, `notify_one` keeps a permit when nobody waits, which is a state that stays set.
- **A value on `broadcast(value)`.** No place of the search passes a value. A caller reads the state that changed, and a value would repeat that state.
- **A kept permit, for the rest of `@zukhruf/pool`.** The rest of the pool resets its event by hand today. With a cond, the pool checks `running.size` and `#size.current` again in the same step before its rest, and the reset at line 139 goes away. A kept permit would add a state that stays set to every cond for one place.

## Consequences

- `Cond` and the word cond are new in this package (see [CONTEXT.md](../../CONTEXT.md)). `WaitOptions` moved to its own file, because `WaitGroup` and `Cond` both take it.
- The 5 hand-written places move onto `Cond` in their own steps (#4547).
- A cancelled wait leaves its callback on the latch until the next broadcast, as a cancelled wait of a wait group does until the next zero.
