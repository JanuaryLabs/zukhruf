# @zukhruf/async

Helpers for code that waits for promises: `untilAborted` cancels a wait, `Latch` holds callers until something happened, `delay` waits a fixed time on a clock, `timeout` stops a wait after a time on a clock, `poll` calls an attempt again until it gives a value, and `pollChanges` reads values again and again and tells which values changed. `@zukhruf/mutex`, `@zukhruf/single-flight` and `@zukhruf/election` use them.

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
const job = await poll(() => queue.take(), {
  interval: 100,
  signal,
  clock: globalThis,
});
```

- Only `undefined` means "no value yet". `null`, `0` and `false` are values.
- An error from the attempt rejects `poll` with the same error. `poll` does not call the attempt again after an error. To try an operation again after an error, see `patiently` of `@zukhruf/fs`.
- When `signal` aborts during a wait, `poll` stops the timer of the wait and rejects with the reason of the signal. A cancel does not stop an attempt that runs.

### Stop at a deadline

A deadline is a time from `clock.performance.now()`, not a duration. Compute it from the clock that you give to `poll`. After the deadline, an attempt that gives `undefined` resolves `poll` with `undefined`. An attempt that gives a value still resolves `poll` with the value.

```ts
const clock = globalThis;
const deadline = clock.performance.now() + 5_000;
const job = await poll(() => queue.take(), {
  interval: 100,
  signal: undefined,
  clock,
  deadline,
});
// job is undefined when the queue stayed empty for 5 seconds.
```

- The first attempt always occurs, also when the deadline is already in the past. Thus a deadline of `clock.performance.now()` gives one attempt.
- A deadline from another clock is wrong for the wait. The type can not find this mistake, because both are numbers.
- One deadline can stop many polls. A campaign of `@zukhruf/election` uses one deadline for all its attempts.
- Without a deadline, the type of the result has no `undefined`.

### Let the process end during a poll

A Node.js process ends when it has no more work. A timer is work. Thus the wait between two attempts keeps the process alive. Some polls run in the background, and their process must be able to end during the poll. For example, a server that does not keep its process alive must not watch a lock with a poll that does.

For such a poll, give `ref: false`. Then the wait does not keep the process alive. The process can end while the poll is pending, and the poll then never resolves.

```ts
// The worker takes jobs, but it does not keep the process alive.
poll(() => queue.take(), {
  interval: 100,
  signal,
  clock: globalThis,
  ref: false,
}).then(run);
```

- With `ref: false`, `poll` calls `unref()` on the timer that `clock.setTimeout` gives, when the timer has one. The timers of Node.js and of `createClock()` have it.
- Without `ref`, Node.js keeps its default: the wait keeps the process alive.
- `ref` changes only the wait between two attempts. An attempt that runs can keep the process alive.

See [ADR 0003](./docs/adr/0003-the-election-and-the-file-lock-stores-poll-through-one-function.md).

## Watch values for a change

A value can change while you are not looking, for example the `data_version` of a SQLite file. To see the changes, read the value again and again. `pollChanges` does this for you. Give it a map: each key has a read, a function that gives the current value of the key. Each check reads each value one time, and yields the set of the keys whose value changed since the previous check.

```ts
import { pollChanges } from '@zukhruf/async';

const reads = new Map([['messages', async () => version.current]]);
const watch = pollChanges(reads, {
  interval: 1_000,
  signal,
  clock: globalThis,
});
for await (const changed of watch) {
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
const watch = pollChanges(reads, {
  interval: 1_000,
  signal,
  clock: globalThis,
});
for await (const changed of watch) {
  await copy(streams.filter((stream) => changed.has(stream.store)));
}
```

### Stop the watch

When `signal` aborts during the wait, `pollChanges` stops the timer, and the loop ends with no error. When the signal aborted before the call, the loop ends before the first read. An abort does not stop a read that runs.

To reject when the signal aborts, call `signal.throwIfAborted()` after the loop.

See [ADR 0004](./docs/adr/0004-a-change-watcher-yields-each-check-with-the-keys-that-changed.md).

## Wait a fixed time

`delay` waits a number of milliseconds on the clock that you give, as `setTimeout` of `node:timers/promises` does on the real clock.

```ts
import { delay } from '@zukhruf/async';

// Wait 100 ms between two tries to reach the server.
await delay(100, { clock: globalThis, signal });
```

- When `signal` aborts, also before the call, the timer stops and `delay` rejects with the reason of the signal.
- No listener stays on the signal after `delay` settles, so a signal that lives long can serve many waits.
- With `ref: false`, the timer does not keep the process alive.

## Stop a wait after a time

`timeout` gives a signal that aborts after a number of milliseconds on the clock that you give, as `AbortSignal.timeout` does on the real clock. Give the signal to a wait. Dispose the timeout when the wait ends.

```ts
import { timeout } from '@zukhruf/async';

// Stop the read when the server does not answer in 5 seconds.
using limit = timeout(5_000, { clock: globalThis });
const state = await readState(container, { signal: limit.signal });
```

- The signal aborts with a `DOMException` whose name is `TimeoutError`, as the signal of `AbortSignal.timeout` does.
- A disposal stops the timer, and the signal then does not abort. `using` disposes the timeout at the end of the block.
- The timer keeps the process alive until it fires or until the disposal. The timer of `AbortSignal.timeout` does not keep the process alive, but no call can stop it.
- To stop a wait at the timeout or at the signal of the caller, give `AbortSignal.any([signal, limit.signal])`.

See [ADR 0006](./docs/adr/0006-a-timeout-is-a-signal-on-the-clock-that-the-caller-gives.md).

## Run a wait on a clock

Each wait of `poll` and `pollChanges` runs on the clock that you give. In production, give `globalThis`: the wait then uses the timers of Node.js. In a test, give a fake clock. The test then moves the time, and the wait takes no real time.

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';

import { poll } from '@zukhruf/async';

test('a job that comes during the second wait', async (t) => {
  const clock = createClock();
  const jobs: string[] = [];
  const job = poll(async () => jobs.shift(), {
    interval: 1_000,
    signal: undefined,
    clock,
  });

  // The first attempt gave no job, so the poll waits on the clock.
  await t.waitFor(() => assert.equal(clock.countTimers(), 1));
  jobs.push('build');
  await clock.tickAsync(1_000);

  assert.equal(await job, 'build');
});
```

- `await clock.tickAsync(ms)` moves the time, and fires each timer that is due, in the order of their times.
- `t.waitFor(() => assert.equal(clock.countTimers(), 1))` waits until the code waits on the clock again. Use it after work that is real, for example a read of a file, before you move the time.
- `clock.setSystemTime(time)` moves the wall clock and does not move `performance.now()`. A deadline does not move with the wall clock.
- `createClock()` does not replace a global, so tests that run at the same time do not see each other's clock.
- The type of the option is `Clock`. It has only the members that the wait calls: `setTimeout`, `clearTimeout` and `performance.now()`. `globalThis` and `createClock()` both have them.

See [ADR 0005](./docs/adr/0005-a-wait-runs-on-the-clock-that-the-caller-gives.md).
