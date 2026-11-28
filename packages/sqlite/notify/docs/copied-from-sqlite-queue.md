# Code copied from sqlite-queue

`@zukhruf/sqlite-queue` keeps its tables in a declaration of `@zukhruf/sqlite-drift` with `rows: 'keep'`, as this package does. The queue records in its file the release that made its tables, and an older release leaves a newer file alone (its [ADR 0006](../../queue/docs/adr/0006-the-file-records-the-release-that-made-its-schema-and-an-older-release-leaves-it-alone.md)). This package needs the same rule ([ADR 0009](./adr/0009-the-file-records-the-release-that-made-its-tables-and-an-older-release-leaves-them-alone.md)), and keeps its own copy of that code.

The reason is the Rule of Three. It counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. The boundary of a shared package then comes from three working copies, not from a guess. This package is the second place. When a third declaration needs the rule, the shared parts move to one place (backlog #4393). The third copy decides where they move, because the queue's ADR 0006 keeps the order of releases out of `@zukhruf/sqlite-drift`. Until then, a fix in one copy is made in the other copy too, and the commit names both files. This note is the input for that step.

Paths on the left are in `packages/sqlite/queue/src`. Paths on the right are in `packages/sqlite/notify/src`. The copies are of the queue's source at `b98871d9`.

## Copied without a change

| sqlite-queue | sqlite-notify |
| ------------ | ------------- |
| `release.ts` | `release.ts`  |

The one line that differs is the comment that names the ADR: `docs/adr/0006` in the queue, `docs/adr/0009` here.

## Copied with changes

**`contractor.ts` → `tables.ts`.**

- The class is `Tables`, and its method is `install`, not `Contractor.start`. Why: `Contractor` is the name of pg-boss, and the queue keeps the names of pg-boss. This package keeps the words of Postgres's `LISTEN` and `NOTIFY`, and they have no contractor.
- The release is in the table `zukhruf_notify_version` of `schema.ts`, not in the `version` column of `pgboss_version`. Why: pg-boss has a `version` table, and this package has none to add a column to. `PRAGMA user_version` is not used: a file has one, backlog #4334 can put the tables of both packages in one file, and a declaration changes only the objects that it names.
- `version` is `NOT NULL`. Why: the queue added its column to a table that releases before it made, so the column is nullable there. Here, the table is new, and each row that the code writes has a version.
- No `PRAGMA foreign_keys` around the transaction. Why: the tables of this package have no foreign keys (the comment in `schema.ts` says why). `Declaration.apply` turns foreign keys off itself only when a stale table is referenced (`packages/sqlite/drift/src/declaration.ts:88-107`), so it never needs them off for these tables. The queue needs them off to rebuild `pgboss_queue`, which `pgboss_job` refers to.
- The comments name Postgres and this package, not the lines of pg-boss.

## Tests copied

**`releases.test.ts` → `releases.test.ts`.**

- `newerRelease` copies the source and `package.json` as the queue's does. The new column is `newer_note` in `zukhruf_notify_queue`, after `payload`. The program of the newer release listens, sends one notification, writes its column on that row and disposes, and it prints nothing.
- The newer release writes a value in its column, and the tests read that value, not only the name of the column. Why: a rebuild that keeps the column and loses its values is the same defect.
- Not copied: the test of a newer release on an older file. That newer release only adds a column, and the tests of `@zukhruf/sqlite-drift` prove that a declaration adds a column and keeps the rows.
- Added: a file of this release whose index differs gets the declaration applied. In the queue, `upgrade.test.ts` catches that case.

**`upgrade.test.ts` (the test of a file whose `pgboss_version` a release before the version column made) → `releases.test.ts` (the test of a file that a release before the version record made).**
Here, the release before the record had no version table, so the test drops `zukhruf_notify_version`. A listener program that listened before still hears, and the file records this release.

**`bundle.test.ts` → `bundle.test.ts`.**
Both prove that a bundle of the package loads in a folder with no `package.json` of the package, because `release.ts` imports the version as JSON (#4516).

- The bundle has no `banner` that gives it a `require`. Why: pg-boss requires CommonJS modules, and this package has no CommonJS dependency.
- The test reads `Notifications`, not `SqliteJobQueue`.

## The thread form (#4984 step 3)

`NotificationsThread` copies parts of `SqliteJobQueueThread` (queue `src/thread/`, the source at `7a469580`). This is strike 2: backlog #6374 waits for a third thread form. Until then, mirror every fix in both copies and name both files in the commit.

**`thread/host-clock.ts` → `thread/host-clock.ts`.**

- Same: the thread's clock over the host's. A timer is armed with `arm(timer, ms)` and cleared with `disarm(timer)` to the host, fires when the host sends `fire(timer)`, and the time is the host's last stamp.
- Differs: it implements `Clock` of `@zukhruf/async` (`setTimeout`, `clearTimeout`, `performance.now()`), not pg-boss's `AttachableClock`. Why: `Notifications` takes that clock. So it has no `setInterval`, no `repeat` flag, and no `attach` or `idle`: `@zukhruf/async` has no clock that a statement waits for.

**`thread/engine-thread.ts` → `thread/engine-thread.ts`.**

- Same: one worker, one `ConnectionSupervisor` over a `WorkerConnection` that is given once, a `Client` and a `Server` on it; `exit` and `disconnected` while serving report the thread lost; `end` and `terminate`; the timers the thread armed on the host's clock, cleared at its exit; `time(now)` before each message on a host clock.
- Differs: no `resourceLimits`, handlers, batches or `idle`. Why: `Notifications` has no handlers and no attached clock. Added: `close()` (dispose the notifications in the thread, then end it) and `crash` (the thread's uncaught error, which an attempt rejects with in place of `ConnectionLostError`). Why: `Notifications` has a dispose that removes its listener row, and a thread that cannot start (a host from `--eval`) must reject `create` with its reason.

**The backoff of `thread/sqlite-job-queue-thread.ts` → `thread/notifications-thread.ts`.**
`backoff(failures)`: 1 s doubling up to 30 s, pg-boss's reconnect. The restart around it differs: there is no session, no `start()` options and no `work()` to replay; the new thread listens again on each wanted channel.

**The test helpers of `thread/sqlite-job-queue-thread.test.ts` → `thread/notifications-thread.test.ts`.**

- `seen`: copied without a change.
- `startHost`: the same host process from a file, with its report on the IPC channel; it takes no `execArgv`, and its module imports `Notifications` and `NotificationsThread`.
