import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';

import type { Clock, PgBossEventMap } from 'pg-boss';

import { transaction } from '@zukhruf/sqlite-transaction';

import type { Activity } from './activity.ts';
import type { SuperviseIntervals } from './attorney.ts';
import { ClaimTimer } from './claim-timer.ts';
import { CurrentOperation } from './in-flight.ts';
import { JobSettler } from './job-settler.ts';
import { QueueStatsCache } from './queue-stats-cache.ts';
import { Row } from './rows.ts';
import { SqlValues } from './sql-values.ts';

// node_modules/pg-boss/dist/boss.js:15
const LARGE_QUEUE = { size: 10_000, message: 'Warning: large queue backlog' };

// The outputs failJobsByTimeout and failJobsByHeartbeat store (plans.js:2969,
// 2973).
const TIMED_OUT = JSON.stringify({ value: { message: 'job timed out' } });
const HEARTBEAT_TIMED_OUT = JSON.stringify({
  value: { message: 'job heartbeat timeout' },
});

// A pass works on at most this many queues at a time (boss.js:304).
const CHUNK = 100;

// The supervisor before its first start, while it supervises a database, and
// after a stop. A stopped supervisor keeps its database for a pass still in
// flight.
type SupervisorPhase =
  | { kind: 'unstarted' }
  | { kind: 'supervising'; database: DatabaseSync; timer: ClaimTimer | null }
  | { kind: 'stopped'; database: DatabaseSync };

export type SupervisorConfig = SuperviseIntervals & {
  supervise: boolean | undefined;
  warningQueueSize: number | undefined;
};

// A queue's stats row as cacheQueueStats returns it, which is also the
// backlog warning's data (plans.js:4472-4476). pinSeconds is how long the
// statement held its snapshot, in real time.
type QueueStatsRow = {
  name: string;
  queuedCount: number;
  warningQueueSize: number;
  pinSeconds: number;
};

// pg-boss's Boss (node_modules/pg-boss/dist/boss.js) for one job table: a
// pass every superviseIntervalSeconds claims each queue's monitor and
// maintenance when due, refreshes the monitored queues' counts, warns about
// backlogs and fails expired and heartbeat-lost jobs, then deletes what the
// maintained queues no longer keep. Each statement is one Activity.query, so
// an attached TestClock waits the whole pass out. The pass's Postgres tail
// (vacuum backoff and check, warning and stats retention, reindex) and
// cleanupDependencies (no job_dependency table) have no counterpart here.
export class Supervisor extends EventEmitter<
  Pick<PgBossEventMap, 'error' | 'warning'>
> {
  readonly #clock: Clock;
  readonly #activity: Activity;
  readonly #config: SupervisorConfig;
  // boss.js:140
  readonly #largeQueueSize: number;
  #phase: SupervisorPhase = { kind: 'unstarted' };
  // pg-boss's #maintaining: the pass in flight.
  readonly #pass = new CurrentOperation<void>();

  constructor(clock: Clock, activity: Activity, config: SupervisorConfig) {
    super();
    this.#clock = clock;
    this.#activity = activity;
    this.#config = config;
    this.#largeQueueSize = config.warningQueueSize || LARGE_QUEUE.size;
  }

  // boss.js:147-156: started whether or not supervise is set, which only
  // decides whether the timer is armed.
  start(database: DatabaseSync): void {
    if (this.#phase.kind === 'supervising') {
      return;
    }
    const timer = this.#config.supervise
      ? new ClaimTimer(this.#clock, this.#config.superviseIntervalSeconds, () =>
          this.#onSupervise(),
        )
      : null;
    this.#phase = { kind: 'supervising', database, timer };
  }

  // boss.js:157-167, which polls its pass flag every 10 ms of real time.
  async stop(): Promise<void> {
    const phase = this.#phase;
    if (phase.kind !== 'supervising') {
      return;
    }
    phase.timer?.stop();
    this.#phase = { kind: 'stopped', database: phase.database };
    await Promise.allSettled([this.#pass.inFlight?.wait()]);
  }

  get #stopped(): boolean {
    return this.#phase.kind !== 'supervising';
  }

  // boss.js:192-218
  async #onSupervise(): Promise<void> {
    if (this.#stopped || this.#pass.inFlight) {
      return;
    }
    await this.#pass.run(this.#supervise());
  }

  async #supervise(): Promise<void> {
    try {
      const names = await this.#query((db) => Supervisor.#queueNames(db));
      if (!this.#stopped) {
        await this.#supervisePass(names);
      }
    } catch (error) {
      this.emit(
        'error',
        Error.isError(error) ? error : new Error(String(error)),
      );
    }
  }

  // boss.js:274-314: the next pass is anchored once every claim is stamped.
  async #supervisePass(names: string[]): Promise<void> {
    for (let start = 0; start < names.length; start += CHUNK) {
      if (this.#stopped) {
        return;
      }
      const chunk = names.slice(start, start + CHUNK);
      await this.#monitor(chunk);
      await this.#maintain(chunk);
    }
    if (this.#phase.kind === 'supervising') {
      this.#phase.timer?.anchor();
    }
  }

  // boss.js:329-423. Nothing here backs off the stats, so every claimed
  // queue's counts are refreshed (refreshStats, plans.js:1374).
  async #monitor(names: string[]): Promise<void> {
    if (this.#stopped) {
      return;
    }
    const claimed = await this.#query((db, now) =>
      Supervisor.#claim(
        db,
        names,
        'monitor_claim_on',
        'COALESCE(monitor_claim_on, monitor_on)',
        this.#config.monitorIntervalSeconds,
        now,
      ),
    );
    if (this.#stopped || claimed.length === 0) {
      return;
    }
    const stats = await this.#query((db, now) =>
      Supervisor.#cacheQueueStats(db, claimed, now, this.#clock),
    );
    if (this.#stopped) {
      return;
    }
    // boss.js:388-394
    for (const row of stats) {
      const threshold = row.warningQueueSize || this.#largeQueueSize;
      if (row.queuedCount > threshold) {
        this.emit('warning', {
          message:
            `${LARGE_QUEUE.message}: queue "${row.name}" has ${row.queuedCount} jobs in the ` +
            `created or retry state, over its warning threshold of ${threshold}. Your queue should be reviewed`,
          data: row,
        });
      }
    }
    if (this.#stopped) {
      return;
    }
    const queues = JSON.stringify(claimed);
    // failJobsByTimeout (plans.js:2957-2961, 2968-2971)
    await this.#query((db, now) =>
      JobSettler.failJobs(
        db,
        [
          `state = 'active'
          AND ${SqlValues.plusSecondsSql('started_on', 'expire_seconds')} < ?
          AND queue_name IN (SELECT value FROM json_each(?))`,
          SqlValues.asIso(now),
          queues,
        ],
        TIMED_OUT,
        now,
      ),
    );
    if (this.#stopped) {
      return;
    }
    // failJobsByHeartbeat (plans.js:2962-2967, 2972-2975)
    await this.#query((db, now) =>
      JobSettler.failJobs(
        db,
        [
          `state = 'active'
          AND heartbeat_seconds IS NOT NULL
          AND ${SqlValues.plusSecondsSql('heartbeat_on', 'heartbeat_seconds')} < ?
          AND queue_name IN (SELECT value FROM json_each(?))`,
          SqlValues.asIso(now),
          queues,
        ],
        HEARTBEAT_TIMED_OUT,
        now,
      ),
    );
  }

  // boss.js:424-511
  async #maintain(names: string[]): Promise<void> {
    if (this.#stopped) {
      return;
    }
    const claimed = await this.#query((db, now) =>
      Supervisor.#claim(
        db,
        names,
        'maintain_on',
        'maintain_on',
        this.#config.maintenanceIntervalSeconds,
        now,
      ),
    );
    if (this.#stopped) {
      return;
    }
    if (claimed.length > 0) {
      // #maintainQueue (boss.js:452-489): the retention sweep counts the
      // completed and cancelled jobs it keeps that finished by DELTA_LAG
      // before it started, and sets retained_count to them. One statement
      // deletes from every claimed queue, so each walk covers its whole queue.
      const before = await this.#query((db, now) => {
        Supervisor.#deletion(db, claimed, now);
        return new Date(now.getTime() - QueueStatsCache.deltaLagSeconds * 1000);
      });
      await this.#query((db, now) => {
        for (const name of claimed) {
          QueueStatsCache.setRetained(db, name, before, now);
        }
      });
    }
  }

  // A statement on the clock's now, run when issued and settled one counted
  // turn later.
  #query<T>(statement: (db: DatabaseSync, now: Date) => T): Promise<T> {
    return this.#activity.query(() => {
      assert(this.#phase.kind !== 'unstarted', 'Database not opened.');
      return statement(this.#phase.database, new Date(this.#clock.now()));
    });
  }

  // getQueues (plans.js:1596-1649) orders the queues by name (12.38.0),
  // which decides each 100-queue chunk; PGlite's C collation and SQLite's
  // BINARY order the queue names alike.
  static #queueNames(db: DatabaseSync): string[] {
    return db
      .prepare('SELECT name FROM pgboss_queue ORDER BY name')
      .all()
      .map((row) => Row.readString(row, 'name'));
  }

  // trySetQueueMonitorTime and trySetQueueTimestamp (plans.js:1360-1377,
  // 1119-1137): a queue is due once its stamp is `seconds` old, or at once
  // without one; the due queues are stamped now. pg-boss takes the rows in
  // name order only as a lock order (queueRowLock, 1146-1148) and leaves its
  // RETURNING order to the planner; SQLite's single writer needs no lock
  // order, and name order keeps the pass's warnings in one stable order.
  static #claim(
    db: DatabaseSync,
    names: string[],
    column: 'monitor_claim_on' | 'maintain_on',
    stamp: string,
    seconds: number,
    now: Date,
  ): string[] {
    return transaction(
      db,
      () => {
        const due = db
          .prepare(
            `SELECT name, ${stamp} AS stamp FROM pgboss_queue
          WHERE name IN (SELECT value FROM json_each(?))
          ORDER BY name`,
          )
          .all(JSON.stringify(names))
          .filter((row) => {
            const stamped = Row.readNullableString(row, 'stamp');
            return (
              stamped === null ||
              (now.getTime() - Date.parse(stamped)) / 1000 >= seconds
            );
          })
          .map((row) => Row.readString(row, 'name'));
        const update = db.prepare(
          `UPDATE pgboss_queue SET ${column} = ? WHERE name = ?`,
        );
        for (const name of due) {
          update.run(SqlValues.asIso(now), name);
        }
        return due;
      },
      { mode: 'immediate' },
    );
  }

  // cacheQueueStats (plans.js:4385-4481): the shared aggregate over the
  // claimed queues, each row with how long the statement held its snapshot.
  static #cacheQueueStats(
    db: DatabaseSync,
    names: string[],
    now: Date,
    clock: Clock,
  ): QueueStatsRow[] {
    const started = clock.now();
    const refreshed = QueueStatsCache.refresh(db, names, now);
    const pinSeconds = (clock.now() - started) / 1000;
    return refreshed.map(({ name, queuedCount, warningQueueSize }) => ({
      name,
      queuedCount,
      warningQueueSize,
      pinSeconds,
    }));
  }

  // deletion (plans.js:3690-3697): settled jobs deletion_seconds after they
  // settled, unless that is 0, and jobs never started once past keep_until.
  static #deletion(db: DatabaseSync, names: string[], now: Date): void {
    const isoNow = SqlValues.asIso(now);
    db.prepare(
      `DELETE FROM pgboss_job
      WHERE queue_name IN (SELECT value FROM json_each(?))
        AND (
          (deletion_seconds > 0 AND ${SqlValues.plusSecondsSql('completed_on', 'deletion_seconds')} < ?)
          OR (state IN ('created', 'retry') AND keep_until < ?)
        )`,
    ).run(JSON.stringify(names), isoNow, isoNow);
  }
}
