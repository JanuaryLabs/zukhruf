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

**Deadline**:
A time from `performance.now()`. After it, an attempt that gives no value ends the poll. A deadline is a time, not a duration.
_Avoid_: Timeout (a timeout is a duration), time limit

**Change watcher**:
`pollChanges`. It does a check, waits an interval, and does the next check. It gives the keys that changed at each check, also when no key changed. An abort ends it.
_Avoid_: Observer, subscription (a subscription gets notifications; a change watcher reads)

**Check**:
One round of a change watcher: it reads each value one time, and compares each value with the value of the previous check. A check that finds no change is still a check.
_Avoid_: Tick (a tick of a timer does not read), poll (a poll stops at a value), probe

**Change**:
A value that differs (`!==`) from the value of the same key at the previous check. At the first check, each key changed, because there is no previous check.
_Avoid_: Update, event, diff

**Stopped event**:
An `abort` event on which a listener called `event.stopImmediatePropagation()`. The listeners that were added after that listener do not run.
_Avoid_: Swallowed event, cancelled event
