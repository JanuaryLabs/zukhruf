# Async

Helpers for code that waits for promises. A caller waits for a promise, and a signal can cancel the wait. Signal and cancel have the meanings that [the mutex glossary](../mutex/CONTEXT.md) gives them.

## Language

**Wait**:
A caller waits for a promise to settle.
_Avoid_: Await (the keyword), block

**Work**:
The operation that a promise stands for. The promise settles when the work ends.
_Avoid_: Task (the mutex runs a task while a caller holds a key), job

**Step**:
The synchronous run of code before the next `await`. Other code runs only between two steps. Thus a wait that starts in the same step as a check of a state sees the same state. The word is one that this package makes: JavaScript runs each step to completion.
_Avoid_: Tick (a tick of a timer), turn (the turn of a caller in the line), microtask (a microtask runs between two steps)

**Cancel**:
A caller stops its own wait with a signal. The wait rejects with the reason of the signal. A cancel stops only the wait: the work continues.
_Avoid_: Abort (the signal aborts; the caller cancels), abandon (in single flight, a flight that all its callers left is abandoned), give up

**Latch**:
A gate that starts closed and opens once, with a value. A wait on the latch ends when the latch opens, and gets the value. The latch never closes again and never rejects.
_Avoid_: Deferred (a deferred can fail), event (an event can happen again), flag

**Future**:
`Future`. It holds the outcome of work that ends once: a value or a failure. The first resolve or reject settles it. Each wait gets the value or rejects with the reason, also a wait that starts after the future settled. It keeps the failure as data, so only a wait rejects. The name is the one of Java `CompletableFuture`, Scala `Promise` and `Future`, and Rust futures.
_Avoid_: Deferred, TaskCompletionSource (the name in .NET), CompletableDeferred (the name in Kotlin), promise (a promise in a field can reject when nobody awaits it)

**Lock**:
`Lock`. It lets one holder at a time hold it: a semaphore of one permit. A lock is not reentrant.
_Avoid_: Mutex (the `@zukhruf/mutex` package; its keys can cross processes), critical section, queue

**Semaphore**:
`Semaphore`. It has a count of permits, and lets at most that many holders hold one at the same time. A caller that finds no free permit waits in the line.
_Avoid_: Limiter, pool (`@zukhruf/pool` lends workers), throttle (a throttle limits calls in a time)

**Permit**:
The right to go on that a caller holds while it does its work. A dispose of the permit gives it back, and a second dispose gives back nothing. For a lock, the permit is the handle that `acquire` gives.
_Avoid_: Token (a token of a wait group counts work; a fencing token of `@zukhruf/mutex` orders writes), slot, ticket

**Line**:
The callers of a lock or a semaphore that wait for a permit, first come first. A dispose gives the permit to the first caller in the line. A caller that cancels leaves the line.
_Avoid_: Queue (`@zukhruf/sqlite-queue` keeps jobs), waiters list

**Holder**:
A caller that holds a permit of a lock or a semaphore, from the grant to the dispose.
_Avoid_: Owner (a holder can give its permit to other code), user

**Ref count**:
`RefCount`. It keeps a handle of the event loop ref'd while work holds a token of it, and unrefs the handle when the last token is disposed. The name comes from libuv's ref and Node's `refCounted`; a ref count does not wait for anything.
_Avoid_: Keep-alive (the word of HTTP and of TCP), wait group (a wait group lets callers wait for zero)

**Wait group**:
`WaitGroup`. It counts the work in flight, one token for each work, and a wait on it ends when the count is zero. The count can go up again after zero: each time it reaches zero, each wait that started before that zero ends. The name is the one of Go `sync.WaitGroup`.
_Avoid_: Countdown, countdown latch (Java `CountDownLatch` and .NET `CountdownEvent` cannot count up after zero), task tracker (the name in tokio_util), latch (a latch opens once)

**Token**:
The handle that `add` of a wait group gives. The wait group counts it until a dispose, and a second dispose changes nothing. The name is the one of tokio_util `TaskTrackerToken`. It is not a fencing token of `@zukhruf/mutex`.
_Avoid_: Permit (a permit is a right to go on; a token only counts), ticket, lease

**Cond**:
`Cond`. It wakes the callers that wait for a change of a state. A broadcast ends each wait that started before it, also a wait that started in the same step, and keeps nothing for a later wait. A cond carries no value: a woken caller checks its state again. The name is the one of Go `sync.Cond`, without its lock.
_Avoid_: Notify (tokio `Notify` keeps a permit for a later wait), event (an event stays set), condition variable with a lock (Python `asyncio.Condition` and Java `Condition` hold a lock), signal (a signal is an `AbortSignal`)

**Broadcast**:
`broadcast()` of a cond. It ends each wait on the cond that started before it, also a wait that started in the same step. It keeps nothing: a broadcast with no wait changes nothing, and a wait that starts after it waits for the next broadcast.
_Avoid_: Notify (tokio `Notify` keeps a permit for a later wait), signal (a signal is an `AbortSignal`), wake one (a broadcast ends each wait)

**Attempt**:
One call that tries to get a value now, and does not wait. It gives the value, or `undefined` when there is no value yet.
_Avoid_: Try (the keyword), check (a check reads values to find a change), probe

**Poll**:
A caller calls an attempt again and again, with a wait between two attempts, until the attempt gives a value. An error from the attempt stops the poll.
_Avoid_: Retry (`patiently` of `@zukhruf/fs` tries an operation again after an error), spin (a spin does not wait), busy wait

**Interval**:
`interval`. The number of milliseconds of the wait between two attempts of a poll, or between two checks of a change watcher. A poll waits it after an attempt that gave no value. A change watcher waits it after a check, from when the consumer asks for the next check.
_Avoid_: Period (a period is a gauge), back-off (the wait of a back-off grows), frequency

**Clock**:
The source of the timers and of the time of a wait. The caller gives it: production gives `globalThis`, and a test gives a fake clock that the test moves. It has only the members that the wait calls.
_Avoid_: TimeProvider (the name in .NET), scheduler, timer (a timer is one wait that the clock starts)

**Wall clock**:
A clock that also gives the wall time, from `Date.now()`. The wall time is the time of the calendar. It can jump, for example when the computer sleeps, but `performance.now()` does not jump. A caller that writes a date, for example the date of a result or the time of a file, takes a wall clock.
_Avoid_: System clock (`globalThis` is the system clock), real-time clock (a hardware clock), calendar

**Delay**:
A wait of a fixed number of milliseconds on a clock. A cancel stops its timer. A delay longer than one timer can hold (2^31-1 ms) runs on a chain of timers, so it lasts the full time.
_Avoid_: Sleep, pause

**Retry**:
A new try of an operation after it failed. The count of retries before a wait is 0 before the first retry.
_Avoid_: Attempt (an attempt is one call of a poll), repeat

**Back-off**:
`Backoff`. It gives the wait before a retry from the count of retries: a wait that grows by `multiplier` from `initial` up to `max`, with a jitter. It keeps no state and does not wait: the caller waits with a delay.
_Avoid_: Retry policy (the policy also decides when to stop), retrier, exponential delay

**Jitter**:
A random change to the wait of a back-off, so that the retries of many callers spread. Its kind is none, ratio, full or equal.
_Avoid_: Noise (the name in Got), randomization factor (the name in cenkalti/backoff)

**Timeout**:
A signal that aborts after a number of milliseconds on a clock. The caller gives the signal to a wait, and the wait stops when the signal aborts. A timeout is a duration that starts when the caller makes it. It counts its time in parts, and a part that ends late, as after a system sleep, uses up only its own length. A disposal of the timeout stops its timer. Unless the caller gives `ref: true`, the timer does not keep the process alive.
_Avoid_: Deadline (a deadline is a time), `AbortSignal.timeout` (it runs only on the real clock), time limit

**Deadline**:
A time from `clock.performance.now()`, from the clock of the poll. After it, an attempt that gives no value ends the poll. A deadline is a time, not a duration.
_Avoid_: Timeout (a timeout is a duration), time limit

**Change watcher**:
`ChangeWatcher`. It does a check, waits an interval, and does the next check. It gives the outcome of each gauge at each check, also when no gauge changed. An abort ends it.
_Avoid_: Observer, subscription (a subscription gets notifications; a change watcher reads)

**Gauge**:
A value that a change watcher reads at each check, for example a data version. Its value is a primitive or a list of values.
_Avoid_: Probe, metric, signal (a signal is an `AbortSignal`)

**Collector**:
One read that gives the values of many keys, for example one query that gives a count for each table. The gauge of one key reads it.
_Avoid_: Batch, loader

**Group**:
A gauge made of gauges. It changes when one member changes, and fails when one member fails.
_Avoid_: Composite, bundle

**Period**:
The count of whole periods since the watch started: a gauge that changes on a schedule.
_Avoid_: Tick, interval (an interval is the wait between two checks)

**Check**:
One round of a change watcher: it reads each gauge one time, and compares each value with the value of the previous check. A check that finds no change is still a check.
_Avoid_: Tick (a tick of a timer does not read), poll (a poll stops at a value), scrape

**Change**:
A value that differs (by `Object.is`) from the value of the same gauge at the previous check that read it. At the first check, each gauge that the check read changed, because there is no previous value.
_Avoid_: Update, event, diff

**Outcome**:
What one check found for one gauge: changed, unchanged, or failed with its error.
_Avoid_: Result, status

**Stopped event**:
An `abort` event on which a listener called `event.stopImmediatePropagation()`. The listeners that were added after that listener do not run.
_Avoid_: Swallowed event, cancelled event
