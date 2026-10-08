# Single flight

Callers of one key share the flight in progress. A caller that comes while a flight runs does not start a second flight. It joins the flight and gets its outcome. The package uses the mutex of `@zukhruf/mutex` to decide which caller runs the flight. Holder, key, lease and lock store have the meanings that [the mutex glossary](../mutex/CONTEXT.md) gives them.

## Language

### Flights

**Flight**:
One run of the work for a key. A key has at most one flight in progress.
_Avoid_: Job, request, call

**Leader**:
The caller whose call runs the flight. In a `SharedFlight`, the leader is also the holder of the key. This term is not the leader of leader election in the mutex glossary.
_Avoid_: Owner, primary

**Join**:
A caller waits for the flight in progress instead of starting one. The caller then gets the outcome of that flight.
_Avoid_: Dedupe, attach, subscribe

**Joiner**:
A caller that joined a flight.
_Avoid_: Follower, waiter (a waiter waits for a key, not for a flight)

**Outcome**:
How a flight ended: succeeded, with its value; failed, with its error; or interrupted, with no value.
_Avoid_: Result, response

**Interrupted**:
The outcome of a flight whose holder stopped before the flight had a value: its process stopped, its lease was lost, or its records refused the outcome.
_Avoid_: Aborted, crashed

**Successor**:
The flight that began after an earlier flight of the key was interrupted. A joiner of the interrupted flight continues with the successor.
_Avoid_: Retry, next run

### Callers that stop waiting

**Cancel**:
A caller stops its own wait with a signal. The call rejects with the reason of the signal. The flight continues for the other callers.
_Avoid_: Abort (the signal aborts; the caller cancels), give up

**Abandoned**:
A flight whose callers all cancelled before it ended. The next call of the key starts a new flight. The work of an abandoned flight gets a signal that aborts, and it can stop early.
_Avoid_: Orphaned, dropped

### Across processes

**Flight record**:
The durable trace of one flight: its id, and its outcome when it has one. A joiner in another process reads it.
_Avoid_: Cache, log, result

**Records**:
The place that keeps the flight records of the keys, for example one directory. Only the holder of a key writes the flight records of the key. Joiners only read them.
_Avoid_: Store (the mutex has lock stores), database

**Follow**:
A joiner in another process reads the flight record of its flight until the flight has an outcome. It asks the mutex for the holder only to learn whether a running flight still has one.
_Avoid_: Poll the lock, wait for the key

**Keep window**:
How long the outcome of a flight stays readable after the flight ended. A joiner that reads later gets no outcome.
_Avoid_: TTL, cache time
