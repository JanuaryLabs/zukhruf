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

**Stopped event**:
An `abort` event on which a listener called `event.stopImmediatePropagation()`. The listeners that were added after that listener do not run.
_Avoid_: Swallowed event, cancelled event
