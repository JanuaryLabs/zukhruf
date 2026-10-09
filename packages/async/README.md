# @zukhruf/async

Helpers for code that waits for promises. The package has one function: `untilAborted`. `@zukhruf/mutex` and `@zukhruf/single-flight` use it.

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
