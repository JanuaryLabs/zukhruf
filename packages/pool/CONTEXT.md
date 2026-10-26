# Pool

A pool lends workers to jobs. The pool decides when workers start, how many run, and when a worker is replaced.

## Language

**Worker**:
A long-lived resource that does one job at a time, such as a coprocess that keeps a model loaded.
_Avoid_: Process (a worker can be a process, but the pool does not need one), resource, connection

**Job**:
The work that a caller gives the pool. The pool lends one worker to the job until the job ends.
_Avoid_: Task (in p-queue a task is a queued function), request

**Lend**:
The pool gives a worker to one job. Only that job uses the worker until the job ends.
_Avoid_: Borrow (the job borrows; the pool lends), acquire, check out

**Slot**:
A place for one worker. A slot is empty, has a worker that starts, has a ready worker, or has a worker that ended.
_Avoid_: Seat, entry

**Startup**:
The class that decides when the workers start: `OnDemand`, `Parallel`, `OrderedReady` or `LeaderFirst`.
_Avoid_: Strategy (a sizing is also a strategy), warm-up (the worker warms up; the startup decides when)

**Sizing**:
The class that decides how many workers run: `Fixed`, `Resources`, `HillClimbing` or `Gradient`.
_Avoid_: Size (a number), capacity (what the computer can give)

**Capacity**:
The most workers the computer can give: one for each CPU, while each finds its memory free.
_Avoid_: Size, limit, ceiling (the ceiling of a sizing is its capacity)

**Window**:
The jobs that a sizing that learns measures at one number of workers: at least 20 jobs and 2 seconds.
_Avoid_: Sample (one job is one sample), batch

**Exit**:
The end of a worker. The pool learns of it from `exited()`, and replaces the worker.
_Avoid_: Death, crash (a crash is one kind of exit)
