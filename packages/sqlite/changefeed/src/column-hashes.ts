import { hash } from 'node:crypto';

import type { Row } from './change-event.ts';

// Each hash is the first 8 bytes of a SHA-256: a changed column goes unseen
// only with a chance of 2^-64.
const width = 8;

/**
 * The fingerprint of a row: one hash for each column, in the order of the
 * table's columns, so an update can name the columns whose values changed.
 */
export function columnHashes(after: Row, columns: readonly string[]): string {
  const hashes = Buffer.allocUnsafe(width * columns.length);
  columns.forEach((column, at) =>
    hash('sha256', canonical(after[column]), 'buffer').copy(
      hashes,
      at * width,
      0,
      width,
    ),
  );
  return hashes.toString('base64url');
}

/** The hashes of a row with the column names that they are in the order of. */
export type ColumnHashes = {
  readonly hashes: string;
  readonly columns: readonly string[];
};

/**
 * The columns whose hashes differ between two fingerprints of one row, also a
 * column that only one of them has. Two fingerprints that differ always name
 * at least one column.
 */
export function changedColumns(
  saved: ColumnHashes,
  current: ColumnHashes,
): readonly [string, ...string[]] {
  const before = byColumn(saved);
  const after = byColumn(current);
  const changed = [
    ...current.columns.filter(
      (column) => before.get(column) !== after.get(column),
    ),
    ...saved.columns.filter((column) => !after.has(column)),
  ];
  const [first, ...rest] = changed;
  if (first === undefined)
    throw new TypeError('An update changed no column of its row');
  return [first, ...rest];
}

function byColumn({ hashes, columns }: ColumnHashes): Map<string, string> {
  const bytes = Buffer.from(hashes, 'base64url');
  return new Map(
    columns.map((column, at) => [
      column,
      bytes.subarray(at * width, (at + 1) * width).toHex(),
    ]),
  );
}

// One text for each value that SQLite gives, with no two values alike: a
// string is its JSON, a bigint has n, bytes have # and base64url.
function canonical(value: Row[string] | undefined): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'number')
    return Object.is(value, -0) ? '-0' : `${value}`;
  if (typeof value === 'string') return JSON.stringify(value);
  return `#${Buffer.from(value).toString('base64url')}`;
}
