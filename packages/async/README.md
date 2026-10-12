# @zukhruf/async

Helpers for code that waits for promises: `untilAborted` cancels a wait, `Latch` holds callers until something happened, and `poll` calls an attempt again until it gives a value. `@zukhruf/mutex`, `@zukhruf/single-flight` and `@zukhruf/election` use them.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Cancel a wait

A caller waits for a promise. The caller wants to stop the wait when a signal aborts, for example after a time limit, or when the user stops the program. `untilAborted` gives a promise that settles in the same way as the promise of the caller. When the signal aborts first, it rejects with the reason of the signal.

```ts
import { untilAborted } from '@zukhruf/async';

const report = buildReport(); // The work. It does not take a signal.
const value = await untilAborted(report, AbortSignal.timeout(5_000));
```

- When `report` settles first, `value` is its value, or the call rejects with its error.
- When the 5 seconds end first, the call rejects with the reason of the signal: a `TimeoutError`.
- When the signal aborted before the call, the call rejects at once.
- When the signal is `undefined`, the call settles in the same way as `report`.

## A cancel stops the wait, not the work

`untilAborted` cannot stop the work. In the example, `buildReport` continues after the cancel. Thus a caller that cancels must deal with the work that continues. For example, a caller of `MemoryStore` that cancels keeps its place in the line, and its place passes the key on when its turn comes.

To stop the work too, give the signal to the work, for example `fetch(url, { signal })`.

## The wait ends also when another listener stops the event

An `AbortSignal` is an `EventTarget`. A listener of the `abort` event can call `event.stopImmediatePropagation()`. Then the listeners that were added after it do not run. A caller often shares its signal with other code. Thus a wait that listens with `addEventListener` can stay pending after the abort.

`untilAborted` listens through `events.addAbortListener` of Node.js. That listener runs also on a stopped event. See [ADR 0001](./docs/adr/0001-a-wait-listens-for-the-abort-through-addabortlistener.md).

## No listener stays on the signal

When the promise settles, `untilAborted` removes its listener. Thus many waits on one signal that lives long, for example a signal that stops a server, do not add listeners to it.

## Wait until something happened, with a latch

A latch starts closed. It opens once, with a value. A wait on a closed latch ends when the latch opens, and gets the value. A wait on an open latch ends at once, with the same value. A latch never closes again, and a second `open` changes nothing.

```ts
import { Latch } from '@zukhruf/async';

const released = new Latch(); // Carries no value.
const done = new Latch<string>(); // Carries a string.

done.open('report');
const value = await done.wait(); // 'report'
```

A latch never rejects. It keeps its value in a box, so it never adopts a promise, whatever its type. Thus a class can keep a latch in a field: the latch cannot fail before somebody awaits it. A latch whose type names a promise refuses one at compile time, because a wait would adopt the promise and could then reject. To share the outcome of work that can fail, give the latch a value that tells how the work ended, for example the `PromiseSettledResult` of `Promise.allSettled`. Each caller then throws the error for itself. See [ADR 0002](./docs/adr/0002-a-latch-carries-a-value-never-a-failure.md).

To stop a wait on a latch, cancel it: `untilAborted(latch.wait(), signal)`.

## Poll an attempt until it gives a value

An attempt tries to get a value now, and it does not wait. For example, it tries to take a lock that another process can hold. The attempt gives the value, or `undefined` when there is no value yet. `poll` calls the attempt. When the attempt gives `undefined`, `poll` waits `interval` milliseconds, and then it calls the attempt again. When the attempt gives a value, `poll` resolves with that value.

```ts
import { poll } from '@zukhruf/async';

// queue.take() gives the next job, or undefined when the queue is empty.
const job = await poll(() => queue.take(), { interval: 100, signal });
```

- Only `undefined` means "no value yet". `null`, `0` and `false` are values.
- An error from the attempt rejects `poll` with the same error. `poll` does not call the attempt again after an error. To try an operation again after an error, see `patiently` of `@zukhruf/fs`.
- When `signal` aborts during a wait, `poll` stops the timer of the wait and rejects with the reason of the signal. A cancel does not stop an attempt that runs.

### Stop at a deadline

A deadline is a time from `performance.now()`, not a duration. After the deadline, an attempt that gives `undefined` resolves `poll` with `undefined`. An attempt that gives a value still resolves `poll` with the value.

```ts
const deadline = performance.now() + 5_000;
const job = await poll(() => queue.take(), {
  interval: 100,
  signal: undefined,
  deadline,
});
// job is undefined when the queue stayed empty for 5 seconds.
```

- The first attempt always occurs, also when the deadline is already in the past. Thus a deadline of `performance.now()` gives one attempt.
- One deadline can stop many polls. A campaign of `@zukhruf/election` uses one deadline for all its attempts.
- Without a deadline, the type of the result has no `undefined`.

See [ADR 0003](./docs/adr/0003-the-election-and-the-file-lock-stores-poll-through-one-function.md).
