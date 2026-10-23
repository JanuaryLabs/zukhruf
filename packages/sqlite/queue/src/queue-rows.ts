import { type QueuePolicy, policies } from 'pg-boss';

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
