import { Declaration } from '@zukhruf/sqlite-drift';

// The documents of a collection. Every row derives from a caller's document
// and the model, so a stale table is replaced with its rows: the next upsert
// of the caller embeds the documents again (docs/adr/0003).
export const collectionSchema = new Declaration(
  [
    `CREATE TABLE embedding_document (
  id TEXT PRIMARY KEY,
  -- sha256 of the model's provider and id and the text (docs/adr/0002).
  hash TEXT NOT NULL,
  -- Milliseconds since the Unix epoch.
  published_at INTEGER NOT NULL,
  -- A unit vector of float32 values, in the byte order of the platform.
  vector BLOB NOT NULL
) STRICT`,
    `CREATE INDEX embedding_document_published_at ON embedding_document (published_at)`,
  ],
  { rows: 'replace' },
);
