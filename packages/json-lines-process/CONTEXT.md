# JSON Lines Process

A child process that the caller keeps for a long time, and that takes and gives JSON values, one on each line.

## Language

**Process**:
The child process that the class starts. It lives until it exits, until `kill`, or until `close`.
_Avoid_: Subprocess, child, worker (a pool lends workers; a worker can be a process)

**Value**:
One JSON value on one line, in either direction.
_Avoid_: Message (in the caller's protocol, one message can need many values), event, payload

**Send**:
The caller writes one value to the stdin of the process.
_Avoid_: Write, post

**Receive**:
The caller waits for the next value on stdout. A receive fails when the process exits first, or when the line is not JSON.
_Avoid_: Read (a reader of a file reads; a caller receives), listen

**Request**:
A send, and the receive of the value that answers it.
_Avoid_: Call, invoke, exchange

**Exit**:
The end of the process, with an exit code or a signal. The exit is an event: `exited()` settles once when it occurs.
_Avoid_: Death, close (close is what the caller asks), crash (a crash is one kind of exit)

**Kill**:
The caller stops the process: SIGTERM first, and SIGKILL after the grace period.
_Avoid_: Terminate, abort (a signal aborts), destroy

**Grace period**:
Five seconds between SIGTERM and SIGKILL. A process that shuts down on its own gets this time.
_Avoid_: Timeout (a caller's time limit for a request), delay

**Close**:
The caller ends stdin and waits for the exit.
_Avoid_: Dispose, shut down, end
