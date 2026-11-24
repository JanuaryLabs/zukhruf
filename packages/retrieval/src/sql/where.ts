import type { Filter } from '../filter.ts';

/**
 * What the filter SQL of one engine needs: how it quotes a column, how it
 * binds a value, and which values it binds. The engine's statement holds its
 * parameters in a `Parameters`, such as a list for `?` and `$1` or a record
 * for `@p0`.
 */
export type SqlDialect<Parameters, Value> = {
  /** A column name as one identifier of the engine. */
  readonly identifier: (name: string) => string;
  /** Adds a value to the parameters of a statement and gives its placeholder. */
  readonly bind: (parameters: Parameters, value: Value) => string;
  /** A filter value as the engine binds it; a TypeError for a value of another kind. */
  readonly value: (value: unknown) => Value;
};

const passageFields = new Set(['source', 'seq', 'start', 'end']);
const metadata = 'metadata.';
// T-SQL has no `TRUE` or `FALSE` condition; `1 = 1` and `1 = 0` are
// conditions in each engine.
const all = '1 = 1';
const none = '1 = 0';

/**
 * The filter as a SQL condition on the passages, aliased `p`, with each value
 * a parameter (ADR 0009). `==` and `!=` compare NULL as a value and `not in`
 * keeps a NULL, as Haystack's pgvector store writes them
 * (`IS NOT DISTINCT FROM`, `IS DISTINCT FROM`, `IS NULL OR NOT IN`).
 */
export function where<Parameters, Value>(
  dialect: SqlDialect<Parameters, Value>,
  filter: Filter | undefined,
  parameters: Parameters,
): string {
  return filter === undefined ? all : condition(dialect, filter, parameters);
}

function condition<Parameters, Value>(
  dialect: SqlDialect<Parameters, Value>,
  filter: Filter,
  parameters: Parameters,
): string {
  if ('conditions' in filter) {
    const parts = filter.conditions.map((part) =>
      condition(dialect, part, parameters),
    );
    if (filter.operator === 'OR')
      return parts.length === 0 ? none : `(${parts.join(' OR ')})`;
    const both = parts.length === 0 ? all : `(${parts.join(' AND ')})`;
    return filter.operator === 'NOT' ? `(NOT ${both})` : both;
  }
  const field = column(dialect, filter.field);
  const { operator, value } = filter;
  if (operator === 'in' || operator === 'not in') {
    if (!Array.isArray(value)) {
      throw new TypeError(
        `The value of an ${JSON.stringify(operator)} filter on ${filter.field} is an array, not ${JSON.stringify(value)}`,
      );
    }
    // Postgres and T-SQL refuse an empty list, `IN ()`; no value is in it.
    if (value.length === 0) return operator === 'in' ? none : all;
    const list = `(${value.map((item) => dialect.bind(parameters, dialect.value(item))).join(', ')})`;
    return operator === 'in'
      ? `${field} IN ${list}`
      : `(${field} IS NULL OR ${field} NOT IN ${list})`;
  }
  const placeholder = dialect.bind(parameters, dialect.value(value));
  if (operator === '==') return `${field} IS NOT DISTINCT FROM ${placeholder}`;
  if (operator === '!=') return `${field} IS DISTINCT FROM ${placeholder}`;
  return `${field} ${operator} ${placeholder}`;
}

function column<Parameters, Value>(
  dialect: SqlDialect<Parameters, Value>,
  field: string,
): string {
  if (passageFields.has(field)) return `p.${dialect.identifier(field)}`;
  if (field.startsWith(metadata))
    return `p.${dialect.identifier(field.slice(metadata.length))}`;
  throw new TypeError(
    `The filter field ${JSON.stringify(field)} is not source, seq, start, end or metadata.<column>`,
  );
}

/**
 * A filter value of an engine with a boolean type, such as Postgres and SQL
 * Server: a boolean stays a boolean.
 */
export function scalar(value: unknown): unknown {
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
