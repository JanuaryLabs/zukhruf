import type { StoredPassage } from '../passage.ts';
import { bind } from './bind.ts';

const passageColumns = new Set(['id', 'source', 'seq', 'start', 'end', 'text']);

/**
 * The SQL of one cell that holds the row of the passages `p` as JSON text,
 * without its `tsvector` columns: a `tsvector` column is a keyword index of
 * the passages, not metadata (ADR 0004). One cell keeps every column of the
 * passages under its own name, whatever cells the search adds beside it, and
 * gives the same values through every driver.
 */
export function passageJson(parameters: unknown[], passages: string): string {
  const relation = bind(parameters, passages);
  return `(to_jsonb(p) - ARRAY(SELECT a."attname"::text FROM pg_attribute a WHERE a."attrelid" = ${relation}::regclass AND a."atttypid" = 'tsvector'::regtype AND a."attnum" > 0 AND NOT a."attisdropped"))::text`;
}

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
