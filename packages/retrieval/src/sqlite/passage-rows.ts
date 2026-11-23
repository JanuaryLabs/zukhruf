import type { SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';

import type { Passage } from '../passage.ts';

// `rowid` is the integer key that the keyword index joins on (ADR 0004): a
// view of the passages exposes it as a column, and it is not metadata.
const passageColumns = new Set([
  'rowid',
  'id',
  'source',
  'seq',
  'start',
  'end',
  'text',
]);

/**
 * Runs a statement whose result ends with `p.*`, the columns of the passages,
 * and gives the cells before them and the passage of each row. A metadata
 * column is any other column of the passages, under its own name, even when
 * it has the name of a cell before it.
 */
export function passageRows(
  statement: StatementSync,
  cellsBefore: number,
  parameters: readonly SQLInputValue[],
): { readonly cells: readonly SQLOutputValue[]; readonly passage: Passage }[] {
  statement.setReturnArrays(true);
  const names = statement
    .columns()
    .slice(cellsBefore)
    .map(({ name }) => name);
  // node:sqlite types each row as a record; with return arrays it is an
  // array, whose values are the cells in the order of the columns.
  return statement.all(...parameters).map((record) => {
    const row = Object.values(record);
    const values = row.slice(cellsBefore);
    const cell = (name: string) => values[names.indexOf(name)];
    return {
      cells: row.slice(0, cellsBefore),
      passage: {
        id: String(cell('id')),
        text: String(cell('text')),
        source: String(cell('source')),
        seq: Number(cell('seq')),
        start: Number(cell('start')),
        end: Number(cell('end')),
        metadata: Object.fromEntries(
          names.flatMap((name, index) =>
            passageColumns.has(name) ? [] : [[name, values[index]]],
          ),
        ),
      },
    };
  });
}
