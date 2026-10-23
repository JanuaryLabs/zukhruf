# The timekeeper is ported literally

A schedule must send a job at each time that its rule gives. pg-boss does this with its timekeeper. A cron pass claims one stamp for all instances, finds the occurrences of the last 60 seconds, and puts one job for each slot in the queue `__pgboss__send-it`. A worker on that queue then sends each job to the queue of the schedule.

Before this change, this package used its own mechanism. A poll on real time read a cursor, `next_run_on`, and sent each due job straight to the queue of the schedule. The parity suite found differences that a program can see. The poll was not on the clock, so a test clock did not move it. It sent a job for each occurrence, also many in one minute. It moved the cursor past a time that came due just before `schedule()`, so that occurrence was lost. It had no `missed` policy and no rrule. Two instances on one file sent the same occurrence two times, because nothing kept one job for each slot.

Thus the package copies the timekeeper of pg-boss 12.35.1, line by line, in `src/timekeeper.ts`: the cron claim and its retry delay, the 60 second window, the slots, the `missed` policies, the rrule walks and the send-it worker. Its timers run on the clock of the queue, at the cadence of pg-boss (`cronMonitorIntervalSeconds` 30, `cronWorkerIntervalSeconds` 5). The first pass runs on a real `setImmediate`, as in pg-boss. The parity suite proves each behavior against pg-boss (`src/parity/timekeeper.test.ts`). The public `runDueSchedules()`, the poll and `next_run_on` are removed.

Three parts of the timekeeper are not ported, because no method of the subset can see them:

- `last_job_id`. pg-boss records the last job of each schedule, and only `getSchedules()` reads it. `getSchedules()` is not in the subset.
- The `invalid_schedule` warnings and the relabel of a schedule kind. pg-boss needs them for rows that an older release or SQL wrote. Here only `schedule()` writes a row, and it refuses a rule that a pass cannot read.
- The loop that measures clock skew. pg-boss compares its clock with the clock of Postgres. Here the clock of the queue is the clock of the database, so the skew is always zero. `clockMonitorIntervalSeconds` is validated only.

## Considered Options

- **Keep the poll on real time.** It gives different jobs than pg-boss, so it breaks the contract of zero divergence.
- **A new scheduler on the clock.** Each difference from pg-boss is then a decision of our own, and the parity suite finds it later.
- **Port the timekeeper of pg-boss literally.** This option was selected.

## Consequences

- A job goes out up to 35 seconds after its time, as in pg-boss: a pass every 30 seconds, then a poll every 5 seconds.
- The table `pgboss_version` keeps the cron stamp. A restart inside the interval waits for the stamp, so two instances on one file do not run more passes than one instance.
- `__pgboss__send-it` is a queue in each database that the queue starts on, as in pg-boss.
- A new version of pg-boss can change the timekeeper. The parity suite then shows the change.
