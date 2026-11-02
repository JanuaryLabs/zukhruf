# Pool

A pool lends workers to jobs. The pool decides when workers start, how many run, when a worker is replaced, and when an idle worker is evicted.

## Language

**Worker**:
A long-lived resource that does one job at a time, such as a coprocess that keeps a model loaded.
_Avoid_: Process (a worker can be a process, but the pool does not need one), resource, connection

**Job**:
The work that a caller gives the pool. The pool lends one worker to the job until the job ends.
_Avoid_: Task (in p-queue a task is a queued function), request

**Lend**:
The pool gives a worker to one job. Only that job uses the worker until the job ends. The pool lends an idle worker first, from the lowest slot.
_Avoid_: Borrow (the job borrows; the pool lends), acquire, check out

**Slot**:
A place for one worker. A slot is empty, has a worker that starts, has a ready worker, has a worker that ended, or is in a back-off. A slot is empty again after the pool evicts its worker.
_Avoid_: Seat, entry

**Startup**:
The class that decides when the workers start: `OnDemand`, `Parallel`, `OrderedReady` or `LeaderFirst`.
_Avoid_: Strategy (a sizing is also a strategy), warm-up (the worker warms up; the startup decides when)

**Sizing**:
The class that decides how many workers run: `Fixed`, `Resources`, `HillClimbing` or `Gradient`.
_Avoid_: Size (a number), capacity (what the computer can give)

**Eviction**:
The class that decides when the pool may evict an idle worker: `NoEviction` or `IdleTimeout`.
_Avoid_: Idle timeout (one class of eviction), policy

**Evict**:
The pool closes an idle worker that its eviction lets go. The slot is then empty. The pool does not count an evicted worker as an exit.
_Avoid_: Retire (the sizing stops keeping a slot), reap, scale down, close (the worker closes)

**Capacity**:
The most workers the computer can give: one for each CPU, while each finds its memory free.
_Avoid_: Size, limit, ceiling (the ceiling of a sizing is its capacity)

**Window**:
The jobs that a sizing that learns measures at one number of workers: at least 20 jobs and 2 seconds.
_Avoid_: Sample (one job is one sample), batch

**Step**:
Three windows of a sizing that learns: at the size it has, at the size it tries (one more worker, or fewer), and at the size it has again. A step with fewer keeps every worker alive.
_Avoid_: Probe, trial, experiment

**Pause**:
The time that a sizing that learns waits after a step that changed nothing: one window, doubled for each such step in a row, up to 16 windows, with a random length of 0.5 to 1.5 times.
_Avoid_: Back-off (an eager pool waits a back-off before it replaces a worker), cooldown, delay

**Exit**:
The end of a worker. The pool learns of it from `exited()`, and replaces the worker.
_Avoid_: Death, crash (a crash is one kind of exit)

**Early exit**:
The exit of a worker that ran less than 10 minutes.
_Avoid_: Crash loop (many early exits in a row make one)

**Back-off**:
The time that an eager pool waits before it replaces a worker after an early exit: 1 s, doubled for each early exit in a row, up to 60 s.
_Avoid_: Delay, cooldown, retry (the pool does not run a job again)

**Idle**:
A ready worker that no job has.
_Avoid_: Free, available

**Stats**:
The counts of the workers that start, the idle workers, the lent workers, and the jobs that wait for a worker, at the moment of one read.
_Avoid_: Metrics (a metric is measured over time), status (one value)
