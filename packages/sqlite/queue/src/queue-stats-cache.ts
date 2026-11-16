import type { DatabaseSync } from 'node:sqlite';

import type { QueueStats } from 'pg-boss';
import { policies } from 'pg-boss';

import { transaction } from '@zukhruf/sqlite-transaction';

import { Row } from './rows.ts';
import type { SqliteRow } from './rows.ts';
import { SqlValues } from './sql-values.ts';

// A queue's counts as the monitor caches them on pgboss_queue
// (node_modules/pg-boss/dist/plans.js:1548-1569). capturedOn is monitor_on,
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
  // getQueueStatsCache (plans.js:1548-1569): undefined for a queue that does
  // not exist.
  static read(db: DatabaseSync, name: string): CachedQueueStats | undefined {
    const row = db
      .prepare(`SELECT ${columns} FROM pgboss_queue WHERE name = ?`)
      .get(name);
    return row === undefined ? undefined : QueueStatsCache.#decode(row);
  }

  // The aggregate of getQueueStats (plans.js:3411-3471) that cacheQueueStats
  // and refreshQueueStats share (3480-3557, 3584-3618): each queue's counts
  // by state, the keys its singleton and stately jobs hold active (NULL for
  // none, as array_agg over no rows) and monitor_on, written and returned in
  // the order of `names`. A name with no queue returns no row.
  static refresh(
    db: DatabaseSync,
    names: string[],
    now: Date,
  ): (CachedQueueStats & { capturedOn: Date })[] {
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
        RETURNING ${columns}`,
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
