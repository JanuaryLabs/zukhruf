import type { StoredPassage } from '../passage.ts';

const passageColumns = new Set(['id', 'source', 'seq', 'start', 'end', 'text']);

/**
 * The SQL of one cell that holds the row of the passages `p` as JSON text.
 * One cell keeps every column of the passages under its own name, whatever
 * cells the search adds beside it. A `BIT` is `true` or `false`, a
 * `DATETIME2` ISO text, and NULL `null`.
 */
export const passageJson =
  '(SELECT p.* FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)';

/** The passage of a cell that `passageJson` gave. A metadata column is any other column of the passages, under its own name. */
export function passage(cell: unknown): StoredPassage {
  const row: Record<string, unknown> = JSON.parse(String(cell));
  return {
    id: String(row['id']),
    text: String(row['text']),
    source: String(row['source']),
    seq: Number(row['seq']),
    start: Number(row['start']),
    end: Number(row['end']),
    metadata: Object.fromEntries(
      Object.entries(row).filter(([name]) => !passageColumns.has(name)),
    ),
  };
}
