# SQLite queue

A program sends jobs to a queue, and workers do them later. This package gives the API of pg-boss, and keeps the jobs in one SQLite file. The parity suite proves that it gives the same results as pg-boss.

## Language

**Job**:
One unit of work that a program sends to a queue: a name, data, and options. A worker gets it, and the handler completes it or fails it.
_Avoid_: Task, message, event

**Queue**:
A named group of jobs with one policy and one set of options, for example retries, expiry and a dead letter queue. `createQueue` makes it.
_Avoid_: Channel, topic, table

**Engine**:
What keeps the jobs: Postgres for pg-boss, SQLite for this package. The API does not change with the engine.
_Avoid_: Backend (the parity suite says backend only for the three forms that it runs: pg-boss, this package on the main thread, and its thread form), driver, adapter

**Subset**:
The 19 methods of `PgBoss` that this package gives, which `JobQueue` declares. A method outside the subset does not exist here.
_Avoid_: Port, facade, compatible API

**Divergence**:
A difference between what pg-boss and this package give for the same calls: a result, a stored row, an event or an error. Zero divergence is the contract.
_Avoid_: Bug, incompatibility, drift (drift is a word of `@zukhruf/sqlite-drift`)

**Parity suite**:
The tests in `src/parity`. Each scenario runs on real pg-boss over PGlite, then on this package on the main thread, then on `SqliteJobQueueThread`, each with one test clock. The test passes only when each observation is deep-equal to pg-boss's (one scenario runs without the thread form, ADR 0008).
_Avoid_: Conformance tests, compatibility tests, golden tests

**Oracle**:
Real pg-boss 12.39.0 on an in-memory PGlite, in the parity suite. What it observes is correct by definition.
_Avoid_: Reference implementation, baseline, mock

**Observation**:
What a scenario returns on one engine: plain values, with each date as milliseconds after the start of the test clock.
_Avoid_: Snapshot, output, result

**Notify queue**:
A queue with `notify: true`. A send of a job that is due now notifies on the channel of pg-boss, in the transaction of the insert. Each instance that listens on the queue file then wakes the workers of the queue. pg-boss's word is the `notify` option of a queue.
_Avoid_: Push queue, realtime queue, instant queue

**Listener**:
A `SqliteJobQueue` with `useListenNotify`, from `start()` to `stop()`. It hears the notifications on the channel of pg-boss, also those of other programs on the same queue file. pg-boss's word (`notifier.js`).
_Avoid_: Subscriber, watcher, notifier (the notifier is the part of pg-boss that owns the listener)

**Worker**:
One polling loop that `work()` starts. It fetches a batch of jobs, gives it to the handler, and waits for the polling interval. `localConcurrency` starts more than one.
_Avoid_: Consumer, processor, thread

**Supervisor**:
The pass that runs every `superviseIntervalSeconds`: it refreshes the counts of the queues, warns about large queues, fails expired jobs and jobs that lost their heartbeat, and deletes the jobs that the queues do not keep.
_Avoid_: Maintenance job, cron, janitor

**Monitor**:
The part of the supervisor pass that runs for a queue once in each `monitorIntervalSeconds`, 60 seconds by default. It counts the jobs of the queue by state and keeps the counts in the queue file, which `getQueueStats` reads. Then it warns about a large queue and fails the expired jobs and the jobs that lost their heartbeat. pg-boss's word (`boss.js:329-423`).
_Avoid_: Stats job, health check, cron monitor (`cronMonitorIntervalSeconds` is the interval of the cron pass)

**Heartbeat**:
The time at which an active job was last touched, for a job with `heartbeatSeconds` (an integer of 10 or more). The fetch sets it, and `touch` sets it again. A worker touches its active jobs every `heartbeatRefreshSeconds`, or half the shortest `heartbeatSeconds` of its batch. When a heartbeat is older than `heartbeatSeconds`, the monitor fails the job with `job heartbeat timeout` (`src/several-processes.test.ts`). pg-boss's word (`manager.js:603-648`, `plans.js:3111-3116, 3121-3124`).
_Avoid_: Keep-alive, ping, lease

**Schedule**:
A cron or rrule rule with a key, which sends a job to its queue at each time that the rule gives.
_Avoid_: Timer, recurring job, cron job

**Cron pass**:
The pass that runs at start and then every `cronMonitorIntervalSeconds`. It finds the occurrences of each schedule that are due, and puts a job for each slot in the send-it queue. A schedule with `precision: 'second'` is not in the send-it queue: the instance whose pass claimed the cron stamp sends a job for each of its occurrences, every second.
_Avoid_: Poll, tick, scheduler run

**Occurrence**:
One time that the rule of a schedule gives. It is due for 60 seconds after that time.
_Avoid_: Fire time, run, trigger

**Slot**:
The minute that an occurrence is in. The send-it queue keeps one job for each schedule and slot, so two passes do not send one occurrence two times.
_Avoid_: Bucket, window (the window is the 60 seconds in which an occurrence is due)

**Send-it queue**:
The queue `__pgboss__send-it`, which the cron pass fills. Its worker sends each job to the queue of its schedule.
_Avoid_: Internal queue, outbox

**Queue file**:
The SQLite file that keeps the queues, the jobs and the schedules. A file that an earlier release made keeps its rows: `start()` makes it store the declared schema.
_Avoid_: Database (also the `database` option), store, old file

**Thread form**:
`SqliteJobQueueThread`: the engine in a worker thread of its own, so its synchronous statements never block the host. Paper v2 of #4984 named the off-thread form of an engine after PGlite's `PGliteWorker`; this package says thread, since worker is a word of pg-boss here.
_Avoid_: Worker (a polling loop of `work()`), off-thread queue, async queue

**Host**:
The thread that made a `SqliteJobQueueThread`, where the `work()` handlers run and the events are emitted.
_Avoid_: Main thread (a host can be a worker thread too), parent, client

**Host clock**:
The clock of a thread form that is not `systemClock`. The engine arms each of its timers on it and reads its time, also through `Date.now`, from the host.
_Avoid_: Remote clock (the word of the paper), proxy clock, fake clock
