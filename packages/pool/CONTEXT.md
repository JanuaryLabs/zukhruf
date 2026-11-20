# Pool

One pool of workers for each computer. Every host sends its jobs to the store of the computer, and the owner lends its workers to them. The owner decides when workers start, how many run, when a worker is replaced, and when an idle worker is evicted.

## Language

**Job**:
Data: the input of one worker kind, which a caller sends to the store, and the output that the owner writes back. The owner lends one worker to the job until the job ends.
_Avoid_: Task, request, message

**Worker**:
A long-lived resource that does one job at a time, such as a coprocess that keeps a model loaded.
_Avoid_: Process (a worker can be a process, but the pool does not need one), resource, connection

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

**Computer**:
The input from which a sizing reads the capacity: the CPU count (`availableParallelism()`) and the free memory (`availableMemory()`). Production gives the functions of Node; a test gives a plain object.
_Avoid_: Machine, host (the host is the program that builds the pool), system, environment

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
The exit of a worker that ran less than 10 minutes. A worker whose warm-up fails also exits early.
_Avoid_: Crash loop (many early exits in a row make one)

**Back-off**:
The time that an eager pool waits before it starts a worker again after an early exit: 1 s, doubled for each early exit in a row, up to 60 s.
_Avoid_: Delay, cooldown, retry (the pool does not run a job again)

**Idle**:
A ready worker that no job has.
_Avoid_: Free, available

**Stats**:
The counts of the owner's workers that start, the idle workers, the lent workers, and the jobs that the owner took and that wait for a worker that starts, at the moment of one read. `pool.stats()` counts the jobs of the kind in the store instead.
_Avoid_: Metrics (a metric is measured over time), status (one value)

**Host**:
One running copy of a program that builds the pool. Several hosts on one computer build the same pool.
_Avoid_: Process, instance

**Owner**:
The one host on a computer that holds the workers of a pool. Leader election picks it.
_Avoid_: Leader (an election term), coordinator, master

**Standby**:
A host that offers its workers and does not own. It starts no workers until it owns.
_Avoid_: Follower, candidate (election terms), replica

**Store**:
The durable place of the jobs of a pool, which every host writes to: a SQLite file on one computer, a Postgres database across computers.
_Avoid_: Queue (one name in the store), database, broker

**Worker kind**:
The name, the revision and the job rules of a pool, with the types of its input and its output. `Pool` and `PoolWorkers` both take it.
_Avoid_: Worker class (the class that `create` builds), job type, task

**Revision**:
The integer of a worker kind that its author raises when `run` changes in a way that matters. Each revision has its own queue in the store. An owner refuses a job of an older revision.
_Avoid_: Version (a release of a package)

**Input**, **Output**:
The JSON data that a job takes and gives. A file goes by reference, never as bytes.
_Avoid_: Payload, arguments, result

**Caller**:
A host whose `run` waits for a job. The job of a caller will be cancelled when the caller's host is gone (not built yet, ADR 0021). A host that only holds a job handle is not a caller.
_Avoid_: Client, sender, requester

**Job handle**:
The value that `start` and `handle(id)` give: the id of one job in the store, a wait for its output, and its cancel. Any host can make the handle of a job from its id until the store deletes the job. In the code: `JobHandle`, after Temporal's `WorkflowHandle`.
_Avoid_: Future, promise (a promise belongs to one host), AsyncResult (Celery's name), ticket

**Shared job**:
A job of a kind whose policy is `exclusive`. Callers that give identical inputs share it.
_Avoid_: Singleton, deduplicated job

**Leave**:
The end of one caller's wait on a shared job, or `cancel()` of its job handle. The store does not change, and the job runs to its end for the other callers.
_Avoid_: Cancel (a cancel ends the job), detach

**Cancel**:
The end of a job that cannot be shared, by its caller or by `cancel()` of its job handle. The store drops the job when it waits, and the owner kills its worker when it runs.
_Avoid_: Abort (the caller's signal aborts, and the pool then cancels or leaves), revoke

**Wake**:
A notification through the store that tells a host to read the store: "a new job" for the owner, or "an output" with a job id for a caller.
_Avoid_: Signal, event, ping

**Backstop**:
The read of the store at a fixed interval that finds what no wake told: a lost wake, or a job that the store's monitor failed.
_Avoid_: Poll (a read with no wake at all), fallback

**Hand-over**:
The owner's clean exit. It stops fetching, finishes its running jobs, resigns and closes its workers.
_Avoid_: Failover (that follows the end of an owner), drain

**Heartbeat**:
The time that a running job stays with its owner after its last touch: 10 s, the least that pg-boss accepts (`attorney.js:578`). When the heartbeat ends, the store's monitor takes the job back, so a job of a dead owner goes back about 11 s after its last touch (ADR 0017).
_Avoid_: Lease, timeout (the kind's `expireInSeconds` limits one run), the election's heartbeat (the leader's signal on its pipe)

**Touch**:
The owner's write to the store that starts the heartbeat of one running job again, every 5 s (half the heartbeat), as pg-boss's `work` does (`manager.js:538`). A touch that affects 0 rows tells the owner that the store took the job back, for example by a cancel, and the owner kills the worker of the job.
_Avoid_: Ping, keep-alive, renew
