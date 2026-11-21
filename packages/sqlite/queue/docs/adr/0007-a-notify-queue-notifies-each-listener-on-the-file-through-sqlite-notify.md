# A notify queue notifies each listener on the file through sqlite-notify

pg-boss sends a `pg_notify` when a send puts a job that is due now in a queue with `notify: true`. The `pg_notify` is in the statement of the insert, so it commits with the job (`node_modules/pg-boss/dist/plans.js:2919-2934`). Each pg-boss instance with `useListenNotify` listens on the channel of the schema. When it hears the queue name, it wakes the workers of that queue, also when they are in another program (`notifier.js:58`, `manager.js:1413-1419`). The poll stays: a worker of a notify queue fetches at least every `notifyPollingIntervalSeconds`, 30 by default (`attorney.js:654`).

SQLite has no `LISTEN` and no `NOTIFY`. Before this change, a send woke only the workers of the same `SqliteJobQueue`. Another instance on the same file waited for its poll. This was a divergence (backlog #4334).

`@zukhruf/sqlite-notify` gives Postgres's `LISTEN` and `NOTIFY` for one SQLite file, among the programs of one computer.

## Decision

- On a queue file, `start()` makes one `Notifications` of `@zukhruf/sqlite-notify`. It uses the connection and the clock of the queue. `stop()` disposes it.
- The channel is the channel of pg-boss: `'pgboss_'` and the first 24 hex digits of the SHA-224 of the schema name (`plans.js:1173-1175`). The schema is always `pgboss`, so the channel is `pgboss_454650302e472074f72063fd`. The payload is the queue name, as in pg-boss.
- A send to a notify queue notifies when the stored job is due now. The notification is in the transaction of the insert, as the `pg_notify` of pg-boss is in its statement. The cron pass does the same for the jobs that it puts in `__pgboss__send-it`, as pg-boss's `insert` does (`manager.js:1740`).
- The sender notifies also when it does not listen, as in pg-boss (`manager.js:1408-1410`).
- With `useListenNotify`, `start()` listens on the channel. Each notification wakes the workers of the queue that the payload names. The instance that sent it also hears it, as a pg-boss listener hears its own `NOTIFY`. When the listen fails, the queue emits pg-boss's warning `listen_notify_unavailable` and the workers poll (`notifier.js:60-71`).
- `stop()` stops the listen first, as pg-boss closes its listener first (`index.js:308`).
- A database in memory has no file that another program can open, and `sqlite-notify` refuses it. A send there wakes only the workers of the same `SqliteJobQueue`, when it listens. The parity suite runs on such a database, so it keeps the timing of PGlite, which gives a `NOTIFY` as the insert runs.

## Considered Options

- **Keep the wake in the instance.** Another instance on the same file waits up to 30 seconds for a job. This is a divergence.
- **Poll faster.** It costs a read of the file for each worker at each interval, and it is not what pg-boss does.
- **Notify only when the sender listens.** pg-boss does not do this. A program that only sends would not wake the workers of another program.
- **Notify through `@zukhruf/sqlite-notify`.** This option was selected.

## Consequences

- On a queue file, `start()` makes the tables of `sqlite-notify` (`zukhruf_notify_*`) if they are missing.
- A listening queue serves a socket in `/tmp/zukhruf-sqlite-notify-<uid>`. A program that only sends serves nothing.
- A send before `start()`, on a `database` of the caller, does not notify, because the `Notifications` starts with `start()`. pg-boss notifies there. The workers of other instances then find the job at their poll.
- A notification is a hint. A lost wake costs at most the backstop of `sqlite-notify`, one second, and the poll of pg-boss stays.
