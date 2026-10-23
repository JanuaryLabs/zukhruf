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
_Avoid_: Backend (the parity suite says backend only for the two engines that it runs), driver, adapter

**Subset**:
The 13 methods of `PgBoss` that this package gives, which `JobQueue` declares. A method outside the subset does not exist here.
_Avoid_: Port, facade, compatible API

**Divergence**:
A difference between what pg-boss and this package give for the same calls: a result, a stored row, an event or an error. Zero divergence is the contract.
_Avoid_: Bug, incompatibility, drift (drift is a word of `@zukhruf/sqlite-drift`)

**Parity suite**:
The tests in `src/parity`. Each scenario runs on real pg-boss over PGlite, then on this package, with one test clock. The test passes only when the two observations are deep-equal.
_Avoid_: Conformance tests, compatibility tests, golden tests

**Oracle**:
Real pg-boss 12.35.1 on an in-memory PGlite, in the parity suite. What it observes is correct by definition.
_Avoid_: Reference implementation, baseline, mock

**Observation**:
What a scenario returns on one engine: plain values, with each date as milliseconds after the start of the test clock.
_Avoid_: Snapshot, output, result

**Worker**:
One polling loop that `work()` starts. It fetches a batch of jobs, gives it to the handler, and waits for the polling interval. `localConcurrency` starts more than one.
_Avoid_: Consumer, processor, thread

**Supervisor**:
The pass that runs every `superviseIntervalSeconds`: it refreshes the counts of the queues, warns about large queues, fails expired jobs and jobs that lost their heartbeat, and deletes the jobs that the queues do not keep.
_Avoid_: Maintenance job, cron, janitor

**Schedule**:
A cron or rrule rule with a key, which sends a job to its queue at each time that the rule gives.
_Avoid_: Timer, recurring job, cron job

**Cron pass**:
The pass that runs at start and then every `cronMonitorIntervalSeconds`. It finds the occurrences of each schedule that are due, and puts a job for each slot in the send-it queue.
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
