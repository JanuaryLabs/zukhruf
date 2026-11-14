import type { SQLOutputValue } from 'node:sqlite';

type Row = Record<string, SQLOutputValue> | undefined;

/** The column of the row as text; the package's own tables declare it TEXT NOT NULL. */
export function text(row: Row, column: string): string {
  const value = row?.[column];
  if (typeof value !== 'string')
    throw new TypeError(`The column ${column} is not text: ${String(value)}`);
  return value;
}

/** The column of the row as an integer, or null for a NULL. */
export function integerOrNull(row: Row, column: string): number | null {
  const value = row?.[column];
  if (value === null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new TypeError(
    `The column ${column} is not an integer: ${String(value)}`,
  );
}

/** The column of the row as an integer. */
export function integer(row: Row, column: string): number {
  const value = integerOrNull(row, column);
  if (value === null)
    throw new TypeError(`The column ${column} is NULL, not an integer`);
  return value;
}
