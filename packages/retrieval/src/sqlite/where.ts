import type { SQLInputValue } from 'node:sqlite';

import type { Filter } from '../filter.ts';
import { identifier } from './identifier.ts';

const passageFields = new Set(['source', 'seq', 'start', 'end']);
const metadata = 'metadata.';

/**
 * The filter as a SQL condition on the passages, aliased `p`, with each value
 * a parameter (ADR 0009). `==` and `!=` compare NULL as a value, and `not in`
 * keeps a NULL, as Haystack's pgvector store does (`IS DISTINCT FROM`,
 * `IS NULL OR != ALL`).
 */
export function where(filter: Filter | undefined): {
  readonly sql: string;
  readonly parameters: readonly SQLInputValue[];
} {
  const parameters: SQLInputValue[] = [];
  const sql = filter === undefined ? '1' : condition(filter, parameters);
  return { sql, parameters };
}

function condition(filter: Filter, parameters: SQLInputValue[]): string {
  if ('conditions' in filter) {
    const parts = filter.conditions.map((part) => condition(part, parameters));
    if (filter.operator === 'OR')
      return parts.length === 0 ? '0' : `(${parts.join(' OR ')})`;
    const all = parts.length === 0 ? '1' : `(${parts.join(' AND ')})`;
    return filter.operator === 'NOT' ? `(NOT ${all})` : all;
  }
  const field = column(filter.field);
  const { operator, value } = filter;
  if (operator === 'in' || operator === 'not in') {
    if (!Array.isArray(value)) {
      throw new TypeError(
        `The value of an ${JSON.stringify(operator)} filter on ${filter.field} is an array, not ${JSON.stringify(value)}`,
      );
    }
    parameters.push(...value.map(parameter));
    const list = `(${value.map(() => '?').join(', ')})`;
    return operator === 'in'
      ? `${field} IN ${list}`
      : `(${field} IS NULL OR ${field} NOT IN ${list})`;
  }
  parameters.push(parameter(value));
  if (operator === '==') return `${field} IS ?`;
  if (operator === '!=') return `${field} IS NOT ?`;
  return `${field} ${operator} ?`;
}

function column(field: string): string {
  if (passageFields.has(field)) return `p.${identifier(field)}`;
  if (field.startsWith(metadata))
    return `p.${identifier(field.slice(metadata.length))}`;
  throw new TypeError(
    `The filter field ${JSON.stringify(field)} is not source, seq, start, end or metadata.<column>`,
  );
}

// SQLite has no boolean: TRUE is 1 and FALSE is 0.
function parameter(value: unknown): SQLInputValue {
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
