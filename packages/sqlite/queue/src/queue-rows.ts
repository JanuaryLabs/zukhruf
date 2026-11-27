import { hash } from 'node:crypto';

import { type QueuePolicy, policies } from 'pg-boss';

import type { ListedQueue } from './job-queue.ts';
import { Row } from './rows.ts';
import type { SqliteRow } from './rows.ts';

export type QueueRow = {
  name: string;
  policy: QueuePolicy;
  retry_limit: number;
  retry_delay_seconds: number;
  retry_backoff: number;
  retry_delay_max_seconds: number | null;
  expire_seconds: number;
  retention_seconds: number;
  deletion_seconds: number;
  heartbeat_seconds: number | null;
  dead_letter: string | null;
  warning_queue_size: number;
  notify: boolean;
  ready_count: number;
  singletons_active: (string | null)[] | null;
};

export class QueueRows {
  static readPolicy(row: SqliteRow): QueueRow['policy'] {
    const policy = Row.readString(row, 'policy');
    if (Object.values(policies).some((known) => known === policy)) {
      return policy;
    }

    throw new Error(`Unsupported SQLite queue policy: ${policy}`);
  }

  static decode(value: unknown): QueueRow {
    const row = Row.parse(value, 'queue');
    return {
      name: Row.readString(row, 'name'),
      policy: QueueRows.readPolicy(row),
      retry_limit: Row.readNumber(row, 'retry_limit'),
      retry_delay_seconds: Row.readNumber(row, 'retry_delay_seconds'),
      retry_backoff: Row.readNumber(row, 'retry_backoff'),
      retry_delay_max_seconds: Row.readNullableNumber(
        row,
        'retry_delay_max_seconds',
      ),
      expire_seconds: Row.readNumber(row, 'expire_seconds'),
      retention_seconds: Row.readNumber(row, 'retention_seconds'),
      deletion_seconds: Row.readNumber(row, 'deletion_seconds'),
      heartbeat_seconds: Row.readNullableNumber(row, 'heartbeat_seconds'),
      dead_letter: Row.readNullableString(row, 'dead_letter'),
      warning_queue_size: Row.readNumber(row, 'warning_queue_size'),
      notify: Row.readNumber(row, 'notify') === 1,
      ready_count: Row.readNumber(row, 'ready_count'),
      singletons_active: QueueRows.#readKeys(row, 'singletons_active'),
    };
  }

  // A row of getQueues (node_modules/pg-boss/dist/plans.js:1615-1668), with
  // the values that pg-boss stores in the columns this schema lacks: a
  // partitioned queue's table is named by create_queue (plans.js:1045-1048),
  // no job here waits on a flow parent, and with persistQueueStats off no
  // pass writes the throughput window, which keeps its defaults
  // (plans.js:369-376, 4538) and toBins gives as null (manager.js:136-138).
  static list(value: unknown): ListedQueue {
    const row = Row.parse(value, 'queue');
    const queue = QueueRows.decode(row);
    const partition = Row.readNumber(row, 'partition') === 1;
    return {
      name: queue.name,
      policy: queue.policy,
      retryLimit: queue.retry_limit,
      retryDelay: queue.retry_delay_seconds,
      retryBackoff: queue.retry_backoff === 1,
      retryDelayMax: queue.retry_delay_max_seconds,
      expireInSeconds: queue.expire_seconds,
      retentionSeconds: queue.retention_seconds,
      deleteAfterSeconds: queue.deletion_seconds,
      partition,
      heartbeatSeconds: queue.heartbeat_seconds,
      notify: queue.notify,
      deadLetter: queue.dead_letter,
      deferredCount: Row.readNumber(row, 'deferred_count'),
      blockedCount: 0,
      warningQueueSize: queue.warning_queue_size,
      queuedCount: Row.readNumber(row, 'queued_count'),
      readyCount: queue.ready_count,
      activeCount: Row.readNumber(row, 'active_count'),
      failedCount: Row.readNumber(row, 'failed_count'),
      totalCount: Row.readNumber(row, 'total_count'),
      createdDelta: 0,
      completedDelta: 0,
      failedDelta: 0,
      deltaSeconds: null,
      deltaOn: null,
      waitBins: null,
      runBins: null,
      readyOldestSeconds: null,
      singletonsActive: queue.singletons_active,
      table: partition ? `j${hash('sha224', queue.name)}` : 'job_common',
      createdOn: QueueRows.#readTime(row, 'created_on'),
      updatedOn: QueueRows.#readTime(row, 'updated_on'),
    };
  }

  // createQueue stamps the clock's time as ISO text; a queue that a release
  // before it made holds the CURRENT_TIMESTAMP default, UTC with no zone.
  static #readTime(row: SqliteRow, column: string): Date {
    const text = Row.readString(row, column);
    return new Date(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
  }

  static #readKeys(row: SqliteRow, column: string): (string | null)[] | null {
    const text = Row.readNullableString(row, column);
    if (text === null) {
      return null;
    }
    const keys: unknown = JSON.parse(text);
    if (
      Array.isArray(keys) &&
      keys.every(
        (key): key is string | null => key === null || typeof key === 'string',
      )
    ) {
      return keys;
    }
    throw new Error(
      `Expected a JSON array of keys in SQLite column: ${column}`,
    );
  }
}
