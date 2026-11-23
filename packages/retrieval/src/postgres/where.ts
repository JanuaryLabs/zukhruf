import type { Filter } from '../filter.ts';
import { bind } from './bind.ts';
import { identifier } from './identifier.ts';

const passageFields = new Set(['source', 'seq', 'start', 'end']);
const metadata = 'metadata.';

/**
 * The filter as a SQL condition on the passages, aliased `p`, with each value
 * a positional parameter (ADR 0009). `==` and `!=` compare NULL as a value
 * and `not in` keeps a NULL, as Haystack's pgvector store writes them
 * (`IS NOT DISTINCT FROM`, `IS DISTINCT FROM`, `IS NULL OR NOT IN`).
 */
export function where(
  filter: Filter | undefined,
  parameters: unknown[],
): string {
  return filter === undefined ? 'TRUE' : condition(filter, parameters);
}

function condition(filter: Filter, parameters: unknown[]): string {
  if ('conditions' in filter) {
    const parts = filter.conditions.map((part) => condition(part, parameters));
    if (filter.operator === 'OR')
      return parts.length === 0 ? 'FALSE' : `(${parts.join(' OR ')})`;
    const all = parts.length === 0 ? 'TRUE' : `(${parts.join(' AND ')})`;
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
    // Postgres refuses an empty list, `IN ()`; no value is in it.
    if (value.length === 0) return operator === 'in' ? 'FALSE' : 'TRUE';
    const list = `(${value.map((item) => bind(parameters, parameter(item))).join(', ')})`;
    return operator === 'in'
      ? `${field} IN ${list}`
      : `(${field} IS NULL OR ${field} NOT IN ${list})`;
  }
  const placeholder = bind(parameters, parameter(value));
  if (operator === '==') return `${field} IS NOT DISTINCT FROM ${placeholder}`;
  if (operator === '!=') return `${field} IS DISTINCT FROM ${placeholder}`;
  return `${field} ${operator} ${placeholder}`;
}

function column(field: string): string {
  if (passageFields.has(field)) return `p.${identifier(field)}`;
  if (field.startsWith(metadata))
    return `p.${identifier(field.slice(metadata.length))}`;
  throw new TypeError(
    `The filter field ${JSON.stringify(field)} is not source, seq, start, end or metadata.<column>`,
  );
}

// Postgres has a boolean, so a boolean value compares with a boolean column.
function parameter(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  throw new TypeError(
    `A filter value is a string, a number, a bigint, a boolean or null, not ${String(value)}`,
  );
}
