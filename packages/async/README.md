# @zukhruf/async

Helpers for code that waits for promises: `untilAborted` cancels a wait, `Latch` holds callers until something happened, `poll` calls an attempt again until it gives a value, and `pollChanges` reads values again and again and tells which values changed. `@zukhruf/mutex`, `@zukhruf/single-flight` and `@zukhruf/election` use them.

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

### Let the process end during a poll

A Node.js process ends when it has no more work. A timer is work. Thus the wait between two attempts keeps the process alive. Some polls run in the background, and their process must be able to end during the poll. For example, a server that does not keep its process alive must not watch a lock with a poll that does.

For such a poll, give `ref: false`. Then the wait does not keep the process alive. The process can end while the poll is pending, and the poll then never resolves.

```ts
// The worker takes jobs, but it does not keep the process alive.
poll(() => queue.take(), { interval: 100, signal, ref: false }).then(run);
```

- `ref` is the `ref` option of the Node.js timer (`setTimeout` of `node:timers/promises`). `poll` gives it to the timer unchanged.
- Without `ref`, Node.js keeps its default: the wait keeps the process alive.
- `ref` changes only the wait between two attempts. An attempt that runs can keep the process alive.

See [ADR 0003](./docs/adr/0003-the-election-and-the-file-lock-stores-poll-through-one-function.md).

## Watch values for a change

A value can change while you are not looking, for example the `data_version` of a SQLite file. To see the changes, read the value again and again. `pollChanges` does this for you. Give it a map: each key has a read, a function that gives the current value of the key. Each check reads each value one time, and yields the set of the keys whose value changed since the previous check.

```ts
import { pollChanges } from '@zukhruf/async';

const reads = new Map([['messages', async () => version.current]]);
for await (const changed of pollChanges(reads, { interval: 1_000, signal })) {
  if (changed.size > 0) await copyMessages();
}
```

- The first check reads at once, and yields all keys: you have never seen the values.
- After each check, `pollChanges` waits `interval` milliseconds after you ask for the next check. A slow loop body thus never gets two checks with no wait between them.
- A check that found no change yields an empty set. Skip it when you need only the changes. Use it when you must know that a check occurred, for example to record that a value is still current.
- `pollChanges` compares each value with `===` to its value at the previous check. Give values that `===` can compare, for example a version number or a string.
- An error from a read ends the loop with the same error.

### Watch many values in one loop

A map with more keys reads each value at each check, one after the other. The set names only the keys that changed. Thus one loop can watch many stores, and give the work only for the stores that changed.

```ts
const reads = new Map([
  ['library', () => library.version()],
  ['annotations', () => annotations.version()],
]);
for await (const changed of pollChanges(reads, { interval: 1_000, signal })) {
  await copy(streams.filter((stream) => changed.has(stream.store)));
}
```

### Stop the watch

When `signal` aborts during the wait, `pollChanges` stops the timer, and the loop ends with no error. When the signal aborted before the call, the loop ends before the first read. An abort does not stop a read that runs.

To reject when the signal aborts, call `signal.throwIfAborted()` after the loop.

See [ADR 0004](./docs/adr/0004-a-change-watcher-yields-each-check-with-the-keys-that-changed.md).
