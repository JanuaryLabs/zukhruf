import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';

import type { Clock, PgBossEventMap } from 'pg-boss';
import { policies } from 'pg-boss';

import { transaction } from '@zukhruf/sqlite-transaction';

import type { Activity } from './activity.ts';
import type { SuperviseIntervals } from './attorney.ts';
import { ClaimTimer } from './claim-timer.ts';
import { InFlight } from './in-flight.ts';
import { JobSettler } from './job-settler.ts';
import { Row } from './rows.ts';
import { SqlValues } from './sql-values.ts';

// node_modules/pg-boss/dist/boss.js:14
const LARGE_QUEUE = { size: 10_000, message: 'Warning: large queue backlog' };

// The outputs failJobsByTimeout and failJobsByHeartbeat store (plans.js:2376,
// 2384).
const TIMED_OUT = JSON.stringify({ value: { message: 'job timed out' } });
const HEARTBEAT_TIMED_OUT = JSON.stringify({
  value: { message: 'job heartbeat timeout' },
});

// A pass works on at most this many queues at a time (boss.js:269).
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
// backlog warning's data (plans.js:3548-3552). pinSeconds is how long the
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
  // boss.js:121
  readonly #largeQueueSize: number;
  #phase: SupervisorPhase = { kind: 'unstarted' };
  // pg-boss's #maintaining: the pass in flight.
  #pass: InFlight<void> | null = null;

  constructor(clock: Clock, activity: Activity, config: SupervisorConfig) {
    super();
    this.#clock = clock;
    this.#activity = activity;
    this.#config = config;
    this.#largeQueueSize = config.warningQueueSize || LARGE_QUEUE.size;
  }

  // boss.js:128-137: started whether or not supervise is set, which only
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

  // boss.js:138-148, which polls its pass flag every 10 ms of real time.
  async stop(): Promise<void> {
    const phase = this.#phase;
    if (phase.kind !== 'supervising') {
      return;
    }
    phase.timer?.stop();
    this.#phase = { kind: 'stopped', database: phase.database };
    await this.#pass?.settled();
  }

  get #stopped(): boolean {
    return this.#phase.kind !== 'supervising';
  }

  // boss.js:173-199
  async #onSupervise(): Promise<void> {
    if (this.#stopped || this.#pass) {
      return;
    }
    const pass = this.#supervise();
    this.#pass = new InFlight(pass);
    try {
      await pass;
    } finally {
      this.#pass = null;
    }
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
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  // boss.js:239-279: the next pass is anchored once every claim is stamped.
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

  // boss.js:293-381. Nothing here backs off the stats, so every claimed
  // queue's counts are refreshed (refreshStats, plans.js:987).
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
      Supervisor.#cacheQueueStats(db, claimed, now),
    );
    if (this.#stopped) {
      return;
    }
    // boss.js:352-358
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
    // failJobsByTimeout (plans.js:2372-2378)
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
    // failJobsByHeartbeat (plans.js:2379-2386)
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

  // boss.js:382-396
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
      await this.#query((db, now) => Supervisor.#deletion(db, claimed, now));
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

  // getQueues (plans.js:1181-1220) has no ORDER BY; PGlite returns the
  // queues in creation order, which decides each 100-queue chunk.
  static #queueNames(db: DatabaseSync): string[] {
    return db
      .prepare('SELECT name FROM pgboss_queue ORDER BY rowid')
      .all()
      .map((row) => Row.readString(row, 'name'));
  }

  // trySetQueueMonitorTime and trySetQueueTimestamp (plans.js:973-990,
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

  // cacheQueueStats over getQueueStats (plans.js:3411-3471, 3480-3557): each
  // claimed queue's counts by state, the keys its singleton and stately jobs
  // hold active (NULL for none, as array_agg over no rows) and monitor_on,
  // written and returned in the claim's order.
  static #cacheQueueStats(
    db: DatabaseSync,
    names: string[],
    now: Date,
  ): QueueStatsRow[] {
    const started = performance.now();
    const isoNow = SqlValues.asIso(now);
    const queues = JSON.stringify(names);
    return transaction(
      db,
      () => {
        const counts = new Map(
          db
            .prepare(
              `SELECT queue_name,
              SUM(state IN ('created', 'retry') AND start_after > ?) AS deferred,
              SUM(state IN ('created', 'retry')) AS queued,
              SUM(state = 'active') AS active,
              SUM(state = 'failed') AS failed,
              COUNT(*) AS total
            FROM pgboss_job
            WHERE queue_name IN (SELECT value FROM json_each(?))
            GROUP BY queue_name`,
            )
            .all(isoNow, queues)
            .map((row) => [Row.readString(row, 'queue_name'), row]),
        );
        const singletons = new Map<string, (string | null)[]>();
        for (const row of db
          .prepare(
            `SELECT queue_name, singleton_key FROM pgboss_job
          WHERE queue_name IN (SELECT value FROM json_each(?))
            AND state = 'active'
            AND policy IN ('${policies.singleton}', '${policies.stately}')
          ORDER BY rowid`,
          )
          .all(queues)) {
          const name = Row.readString(row, 'queue_name');
          singletons.set(name, [
            ...(singletons.get(name) ?? []),
            Row.readNullableString(row, 'singleton_key'),
          ]);
        }
        const update = db.prepare(
          `UPDATE pgboss_queue SET
          deferred_count = ?,
          queued_count = ?,
          ready_count = ?,
          active_count = ?,
          failed_count = ?,
          total_count = ?,
          singletons_active = ?,
          monitor_on = ?
        WHERE name = ?
        RETURNING name, queued_count, warning_queue_size`,
        );
        return names.flatMap((name) => {
          const row = counts.get(name);
          const count = (column: string) =>
            row ? Row.readNumber(row, column) : 0;
          const keys = singletons.get(name);
          const written = update.get(
            count('deferred'),
            count('queued'),
            Math.max(count('queued') - count('deferred'), 0),
            count('active'),
            count('failed'),
            count('total'),
            keys ? JSON.stringify(keys) : null,
            isoNow,
            name,
          );
          return written === undefined
            ? []
            : [
                {
                  name: Row.readString(written, 'name'),
                  queuedCount: Row.readNumber(written, 'queued_count'),
                  warningQueueSize: Row.readNumber(
                    written,
                    'warning_queue_size',
                  ),
                  pinSeconds: (performance.now() - started) / 1000,
                },
              ];
        });
      },
      { mode: 'immediate' },
    );
  }

  // deletion (plans.js:3055-3066): settled jobs deletion_seconds after they
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
