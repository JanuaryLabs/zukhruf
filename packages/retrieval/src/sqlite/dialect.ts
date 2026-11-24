import type { SQLInputValue } from 'node:sqlite';

import { identifier } from '../sql/identifier.ts';
import type { SqlDialect } from '../sql/where.ts';

/** The filter SQL of SQLite: `?` placeholders in the order of a list. */
export const dialect: SqlDialect<SQLInputValue[], SQLInputValue> = {
  identifier,
  bind: (parameters, value) => {
    parameters.push(value);
    return '?';
  },
  value,
};

// SQLite has no boolean: TRUE is 1 and FALSE is 0.
function value(value: unknown): SQLInputValue {
  if (typeof value === 'boolean') return Number(value);
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new TypeError(
    `A filter value is a string, a number, a bigint, a boolean, null or a Uint8Array, not ${String(value)}`,
  );
}
