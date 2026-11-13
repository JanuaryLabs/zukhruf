# Async

Helpers for code that waits for promises. A caller waits for a promise, and a signal can cancel the wait. Signal and cancel have the meanings that [the mutex glossary](../mutex/CONTEXT.md) gives them.

## Language

**Wait**:
A caller waits for a promise to settle.
_Avoid_: Await (the keyword), block

**Work**:
The operation that a promise stands for. The promise settles when the work ends.
_Avoid_: Task (the mutex runs a task while a caller holds a key), job

**Cancel**:
A caller stops its own wait with a signal. The wait rejects with the reason of the signal. A cancel stops only the wait: the work continues.
_Avoid_: Abort (the signal aborts; the caller cancels), abandon (in single flight, a flight that all its callers left is abandoned), give up

**Latch**:
A gate that starts closed and opens once, with a value. A wait on the latch ends when the latch opens, and gets the value. The latch never closes again and never rejects.
_Avoid_: Deferred, future (both can fail), event (an event can happen again), flag

**Attempt**:
One call that tries to get a value now, and does not wait. It gives the value, or `undefined` when there is no value yet.
_Avoid_: Try (the keyword), check (a check reads values to find a change), probe

**Poll**:
A caller calls an attempt again and again, with a wait between two attempts, until the attempt gives a value. An error from the attempt stops the poll.
_Avoid_: Retry (`patiently` of `@zukhruf/fs` tries an operation again after an error), spin (a spin does not wait), busy wait

**Clock**:
The source of the timers and of the time of a wait. The caller gives it: production gives `globalThis`, and a test gives a fake clock that the test moves. It has only the members that the wait calls.
_Avoid_: TimeProvider (the name in .NET), scheduler, timer (a timer is one wait that the clock starts)

**Wall clock**:
A clock that also gives the wall time, from `Date.now()`. The wall time is the time of the calendar. It can jump, for example when the computer sleeps, but `performance.now()` does not jump. A caller that writes a date, for example the date of a result or the time of a file, takes a wall clock.
_Avoid_: System clock (`globalThis` is the system clock), real-time clock (a hardware clock), calendar

**Delay**:
A wait of a fixed number of milliseconds on a clock. A cancel stops its timer. A delay longer than one timer can hold (2^31-1 ms) runs on a chain of timers, so it lasts the full time.
_Avoid_: Sleep, pause

**Timeout**:
A signal that aborts after a number of milliseconds on a clock. The caller gives the signal to a wait, and the wait stops when the signal aborts. A timeout is a duration that starts when the caller makes it. It counts its time in parts, and a part that ends late, as after a system sleep, uses up only its own length. A disposal of the timeout stops its timer.
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
