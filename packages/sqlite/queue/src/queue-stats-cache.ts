import type { DatabaseSync } from 'node:sqlite';

import type { QueueStats } from 'pg-boss';
import { policies } from 'pg-boss';

import { transaction } from '@zukhruf/sqlite-transaction';

import { Row } from './rows.ts';
import type { SqliteRow } from './rows.ts';
import { SqlValues } from './sql-values.ts';

// A queue's counts as the monitor caches them on pgboss_queue
// (node_modules/pg-boss/dist/plans.js:2041-2065). capturedOn is monitor_on,
// null until something counted the queue.
export type CachedQueueStats = Pick<
  QueueStats,
  | 'name'
  | 'deferredCount'
  | 'queuedCount'
  | 'readyCount'
  | 'activeCount'
  | 'failedCount'
  | 'totalCount'
> & { capturedOn: Date | null; warningQueueSize: number };

const columns = `name,
  deferred_count,
  queued_count,
  ready_count,
  active_count,
  failed_count,
  total_count,
  monitor_on,
  warning_queue_size`;

// The cache of each queue's counts that the supervisor's monitor and
// getQueueStats both write, and getQueueStats serves.
export class QueueStatsCache {
  // DELTA_LAG_SECONDS (plans.js:3943): a completion stamped before a pass but
  // committed after it is still ahead of the watermark.
  static readonly deltaLagSeconds = 10;

  // setRetainedCount (plans.js:3776-3797), after a maintenance pass deleted
  // what it deletes: the completed and cancelled jobs it left that finished
  // by `before`, which retained_on moves to; total_count is the live jobs the
  // last monitor pass counted plus them and the ones finished since.
  static setRetained(
    db: DatabaseSync,
    name: string,
    before: Date,
    now: Date,
  ): void {
    db.prepare(
      `UPDATE pgboss_queue SET
        retained_count = (SELECT COUNT(*) FROM pgboss_job
          WHERE queue_name = ?1 AND completed_on <= ?2
            AND state IN ('completed', 'cancelled')),
        retained_on = ?2,
        total_count = queued_count + active_count + failed_count
          + (SELECT COUNT(*) FROM pgboss_job
            WHERE queue_name = ?1 AND completed_on <= ?2
              AND state IN ('completed', 'cancelled'))
          + (SELECT COUNT(*) FROM pgboss_job
            WHERE queue_name = ?1 AND completed_on > ?2 AND completed_on <= ?3
              AND state IN ('completed', 'cancelled'))
      WHERE name = ?1`,
    ).run(name, SqlValues.asIso(before), SqlValues.asIso(now));
  }
  // getQueueStatsCache (plans.js:2041-2065): undefined for a queue that does
  // not exist.
  static read(db: DatabaseSync, name: string): CachedQueueStats | undefined {
    const row = db
      .prepare(`SELECT ${columns} FROM pgboss_queue WHERE name = ?`)
      .get(name);
    return row === undefined ? undefined : QueueStatsCache.#decode(row);
  }

  // The aggregate of getQueueStats (plans.js:4219-4376) that cacheQueueStats
  // and refreshQueueStats share (4385-4481, 4508-4543): each queue's counts
  // by state, the keys its singleton and stately jobs hold active (NULL for
  // none, as array_agg over no rows) and monitor_on, written and returned in
  // the order of `names`. A name with no queue returns no row.
  static refresh(
    db: DatabaseSync,
    names: string[],
    now: Date,
  ): (CachedQueueStats & { capturedOn: Date })[] {
    const isoNow = SqlValues.asIso(now);
    // deltaWindowEnd (plans.js:3943-3954): the pass counts finished jobs into
    // retained_count only up to DELTA_LAG before now.
    const isoEnd = SqlValues.asIso(
      new Date(now.getTime() - QueueStatsCache.deltaLagSeconds * 1000),
    );
    const queues = JSON.stringify(names);
    return transaction(
      db,
      () => {
        // Only the live jobs (LIVE_STATES, plans.js:97): the finished ones
        // are counted through retained_count (12.38.0).
        const counts = new Map(
          db
            .prepare(
              `SELECT queue_name,
              SUM(state IN ('created', 'retry') AND start_after > ?) AS deferred,
              SUM(state IN ('created', 'retry')) AS queued,
              SUM(state = 'active') AS active,
              SUM(state = 'failed') AS failed,
              COUNT(*) AS live
            FROM pgboss_job
            WHERE queue_name IN (SELECT value FROM json_each(?))
              AND state IN ('created', 'retry', 'active', 'failed')
            GROUP BY queue_name`,
            )
            .all(isoNow, queues)
            .map((row) => [Row.readString(row, 'queue_name'), row]),
        );
        // The jobs completed or cancelled since retained_on up to the window's
        // end, and those after it (plans.js:4322-4337). SQLite's MAX() is NULL
        // with a NULL argument, where Postgres's GREATEST skips it.
        const retained = new Map(
          db
            .prepare(
              `SELECT q.name, q.total_count, q.retained_count, q.retained_on,
              (SELECT COUNT(*) FROM pgboss_job j
                WHERE j.queue_name = q.name
                  AND j.completed_on > q.retained_on
                  AND j.completed_on <= ?1
                  AND j.state IN ('completed', 'cancelled')) AS since,
              (SELECT COUNT(*) FROM pgboss_job j
                WHERE j.queue_name = q.name
                  AND j.completed_on > MAX(COALESCE(q.retained_on, ?1), ?1)
                  AND j.completed_on <= ?2
                  AND j.state IN ('completed', 'cancelled')) AS recent
            FROM pgboss_queue q
            WHERE q.name IN (SELECT value FROM json_each(?3))`,
            )
            .all(isoEnd, isoNow, queues)
            .map((row) => [Row.readString(row, 'name'), row]),
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
          retained_count = ?,
          retained_on = ?,
          singletons_active = ?,
          monitor_on = ?
        WHERE name = ?
        RETURNING ${columns}`,
        );
        return names.flatMap((name) => {
          const row = counts.get(name);
          const count = (column: string) =>
            row ? Row.readNumber(row, column) : 0;
          const keys = singletons.get(name);
          // retainedAssignments (plans.js:4352-4380). The read above and this
          // write share the transaction, so retained_on is still the one the
          // finished jobs were counted from. A queue no maintenance pass has
          // counted keeps the larger of its total and its live jobs.
          const queue = retained.get(name);
          const retainedCount = queue
            ? Row.readNullableNumber(queue, 'retained_count')
            : null;
          const retainedOn = queue
            ? Row.readNullableString(queue, 'retained_on')
            : null;
          const live = count('live');
          const nextRetained =
            retainedCount === null || queue === undefined
              ? null
              : retainedCount + Row.readNumber(queue, 'since');
          const total =
            nextRetained === null || queue === undefined
              ? Math.max(queue ? Row.readNumber(queue, 'total_count') : 0, live)
              : live + nextRetained + Row.readNumber(queue, 'recent');
          const written = update.get(
            count('deferred'),
            count('queued'),
            Math.max(count('queued') - count('deferred'), 0),
            count('active'),
            count('failed'),
            total,
            nextRetained,
            retainedOn === null || retainedOn > isoEnd ? retainedOn : isoEnd,
            keys ? JSON.stringify(keys) : null,
            isoNow,
            name,
          );
          return written === undefined
            ? []
            : [{ ...QueueStatsCache.#decode(written), capturedOn: now }];
        });
      },
      { mode: 'immediate' },
    );
  }

  static #decode(row: SqliteRow): CachedQueueStats {
    const monitorOn = Row.readNullableString(row, 'monitor_on');
    return {
      name: Row.readString(row, 'name'),
      deferredCount: Row.readNumber(row, 'deferred_count'),
      queuedCount: Row.readNumber(row, 'queued_count'),
      readyCount: Row.readNumber(row, 'ready_count'),
      activeCount: Row.readNumber(row, 'active_count'),
      failedCount: Row.readNumber(row, 'failed_count'),
      totalCount: Row.readNumber(row, 'total_count'),
      capturedOn: monitorOn === null ? null : new Date(monitorOn),
      warningQueueSize: Row.readNumber(row, 'warning_queue_size'),
    };
  }
}
