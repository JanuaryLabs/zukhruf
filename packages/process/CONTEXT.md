# Process

A process that this program starts, from its start to its end: a run that waits for the end, or a started process that this program keeps and talks to. The package owns how a process starts, ends, stops and is ready. The command, its arguments and its environment come from the caller.

## Language

**Command**:
What to run: a file, its arguments, its environment, its folder, its grace and its name. A command starts nothing until `run()` or `start()`, and it can run or start more than once.
_Avoid_: Cmd, job, spec

**Run**:
One process that this program starts and waits for until it ends. It gives the end and the output. `run()` of a command makes a run.
_Avoid_: Exec, call

**Started process**:
A process that this program starts and keeps until it ends or until this program stops it. `start()` of a command gives one.
_Avoid_: Child, subprocess, worker (for the process itself)

**End**:
How a process ended: an exit code, or the signal that ended it. A process has one end, and it has it once.
_Avoid_: Exit status, result (for the end alone)

**Output**:
What a run printed: its stdout, its stderr, and both in the order that the process wrote them.

**Stop**:
SIGTERM and then SIGCONT to the process group of a started process, and SIGKILL to the group after the grace.
_Avoid_: Kill (for the two steps together)

**Grace**:
The time from SIGTERM to SIGKILL in a stop. 5 seconds unless the caller gives one.

**Signal** (of a started process):
One signal sent to the program alone, not to its group. It reaches only a program that has not ended.
_Avoid_: Kill (for a signal that does not end the program)

**Inherited stream**:
A stdout or stderr of a started process that is the stdout or stderr of this program, so a person at the terminal sees it. A started process has no inherited stdin.

**Parent**:
The program that started the process. A started process ends when its parent ends, also when the parent is killed.

**Ready**:
The moment that a started process says it can work: a line on its stdout, or a message on its IPC channel. `start()` of a command resolves at that moment.
_Avoid_: Healthy, up, listening (for the moment itself)

**Node process**:
A started process that runs a module of JavaScript source in its own Node.js, with an IPC channel back to its parent. Only a Node process has messages.

**Message**:
A value that a Node process sends to its parent over the IPC channel, or that the parent sends to it.

**Coprocess**:
A started process that its parent talks to over its stdin and stdout, one JSON value on each line, as with `coproc` in bash. `Coprocess` is the JSON-lines view of a started process.

**Stderr tail**:
The last 16 384 characters of the stderr of a started process, or of a run in an `ExitError`. The errors of a started process carry it. A run keeps all of its stderr.

**Accepted end**:
An end that the caller of a run accepts, such as exit code 0. For any other end, the caller throws an `ExitError`.
