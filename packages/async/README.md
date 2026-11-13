# @zukhruf/async

Helpers for code that waits for promises: `untilAborted` cancels a wait, `Latch` holds callers until something happened, `delay` waits a fixed time on a clock, `timeout` stops a wait after a time on a clock, `poll` calls an attempt again until it gives a value, and `ChangeWatcher` reads gauges again and again and tells which values changed. `@zukhruf/mutex`, `@zukhruf/single-flight` and `@zukhruf/election` use them.

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

A value can change while you are not looking, for example the `data_version` of a SQLite file. To see the changes, read the value again and again. `ChangeWatcher` does this for you. Give it gauges: a gauge is a value that the watcher reads at each check. Each check reads each gauge one time, all at the same time, and gives the outcome of each gauge: `changed`, `unchanged` or `failed`.

```ts
import { ChangeWatcher, Gauge } from '@zukhruf/async';

class MessagesVersion extends Gauge<number> {
  protected async read() {
    return version.current;
  }
}

const messages = new MessagesVersion();
const watcher = new ChangeWatcher([messages], {
  interval: 1_000,
  timeout: 1_000,
  clock: globalThis,
});
for await (const outcomes of watcher.watch(signal)) {
  if (outcomes.get(messages)?.state === 'changed') await copyMessages();
}
```

- The first check reads at once. Each gauge that it can read changed: you have never seen its value.
- After each check, the watcher waits `interval` milliseconds after you ask for the next check. A slow loop body thus never gets two checks with no wait between them.
- A check that found no change gives each gauge `unchanged`. Use it when you must know that a check occurred, for example to record that a value is still current.
- A value is a primitive (a string, a number, a bigint, a boolean, `null` or `undefined`) or a list of values. The watcher compares it with `Object.is` to its value at the previous check, member by member for a list. Thus `NaN` does not change at each check.

### A failed read fails only its gauge

When the read of a gauge fails, its outcome is `failed`, with the error. The other gauges of the check go on. A failed gauge keeps its last value: after it recovers, it changed only when its value differs from that last value. You decide what a failure means, for example to stop your loop.

The reads of one check have `timeout` milliseconds. A read that takes longer fails with a `TimeoutError`, also a read that never answers. Give `check.signal` to the I/O of a read, so that the read stops too.

### Watch many values

Give the watcher many gauges. It reads each one at each check, and gives an outcome for each.

When one read gives the values of many keys, for example one query that gives a count for each table, write a `Collector`. Its `collect` runs one time in each check, however many of its keys you watch. `collector.gauge(key)` gives the gauge of one key. Its value is `undefined` when the read did not give the key, so a key that appears or disappears changed.

```ts
class RowCounts extends Collector<string> {
  protected collect(check: Check) {
    return session.rowCounts(check.signal);
  }
}

const rows = new RowCounts();
const notes = rows.gauge('[dbo].[notes]');
const orders = rows.gauge('[dbo].[orders]');
const watcher = new ChangeWatcher([notes, orders], {
  interval: 30_000,
  timeout: 10_000,
  clock,
});
```

A `Group` is a gauge made of gauges. It changed when one of its members changed, and it failed when one of its members failed. Watch one group for each thing that you refresh, for example one table and the gauges that see its changes.

A `Period` is the count of whole periods since the watch started. Put it in a group to read again on a schedule, also when no other gauge saw a change:

```ts
const hour = new Period(60 * 60_000);
const table = new Group([rows.gauge('[dbo].[notes]'), hour]);
```

### Stop the watch

When `signal` aborts, the loop ends with no error: during the wait, during the reads, and also while your loop body holds a check. The timer stops. When the signal aborted before the call, the loop ends before the first read. An abort does not stop a read that runs, but `check.signal` tells it.

To reject when the signal aborts, call `signal.throwIfAborted()` after the loop.

See [ADR 0004](./docs/adr/0004-a-change-watcher-yields-each-check-with-the-keys-that-changed.md) and [ADR 0008](./docs/adr/0008-a-change-watcher-reads-gauges.md).

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
- A wait can be longer than one timer can hold. A timer of Node.js holds at most 2^31-1 ms, about 24.8 days, and fires a longer delay after 1 ms. `delay` then waits on a chain of timers of at most 2^31-1 ms, so a wait of 30 days lasts 30 days. Thus `poll`, `timeout` and the `interval` and `timeout` of `ChangeWatcher` can also be that long.

See [ADR 0009](./docs/adr/0009-a-wait-longer-than-one-timer-runs-on-a-chain-of-timers.md).

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
- The time runs in ten parts, each on one timer of at most 2^31-1 ms, so a timeout can be longer than one timer can hold.
- A part that ends late uses up only its own length. On macOS, a timer of Node.js counts the time of a system sleep, so a timer that was running when the computer slept fires at the wake. The timeout then still gives the wait the rest of its time: a timeout of 5 seconds that slept in its first half second aborts 4.5 seconds after the wake, not at the wake. A process that the system stopped gets the same.

See [ADR 0006](./docs/adr/0006-a-timeout-is-a-signal-on-the-clock-that-the-caller-gives.md) and [ADR 0010](./docs/adr/0010-a-timeout-counts-its-time-in-parts.md).

## Run a wait on a clock

Each wait of `poll` and `ChangeWatcher` runs on the clock that you give. In production, give `globalThis`: the wait then uses the timers of Node.js. In a test, give a fake clock. The test then moves the time, and the wait takes no real time.

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

### Read the wall time from the clock

A library that also reads the wall time, for example the date of a result, takes a `WallClock`. A `WallClock` is a `Clock` that also has `Date.now()`. `globalThis` and `createClock()` both have it. In a test, `clock.setSystemTime(time)` sets the wall time.

```ts
import type { WallClock } from '@zukhruf/async';

function stamp(result: string, clock: WallClock) {
  return { result, date: new Date(clock.Date.now()).toISOString() };
}

stamp('passed', globalThis);
```

The wall time can jump, for example when a time server sets it. `performance.now()` does not jump. Thus a deadline uses `performance.now()`, and never the wall time. On macOS, `performance.now()` and the timers of Node.js count the time of a system sleep; a `timeout` does not, see [Stop a wait after a time](#stop-a-wait-after-a-time).

See [ADR 0005](./docs/adr/0005-a-wait-runs-on-the-clock-that-the-caller-gives.md).
