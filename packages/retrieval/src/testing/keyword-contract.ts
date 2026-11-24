import type { DatabaseSync } from 'node:sqlite';

export type KeywordPassage = {
  readonly id: string;
  readonly text: string;
  readonly source?: string;
  readonly product?: string;
};

/**
 * The passages and the keyword index as elt writes them (ADR 0004): elt's
 * parts; a keywords table with the id, source, seq and text of each passage;
 * an FTS5 table with the keywords table as its external content, which a
 * trigger keeps in step (elt also deletes and updates through triggers); and
 * the passages, a view whose rowid is the rowid of the keywords.
 */
export const keywordContractSchema = `
  CREATE TABLE docs_parts (source TEXT NOT NULL, seq INTEGER NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL, text TEXT NOT NULL, product TEXT, PRIMARY KEY (source, seq)) STRICT;
  CREATE TABLE docs_keywords (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, source TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL) STRICT;
  CREATE VIRTUAL TABLE docs_passages_fts USING fts5(text, content = 'docs_keywords');
  CREATE TRIGGER docs_keywords_ai AFTER INSERT ON docs_keywords BEGIN INSERT INTO docs_passages_fts (rowid, text) VALUES (new.rowid, new.text); END;
  CREATE VIEW docs_passages AS SELECT k.rowid AS rowid, k.id, p.source, p.seq, p.start, p."end", p.text, p.product FROM docs_keywords k JOIN docs_parts p ON p.source = k.source AND p.seq = k.seq;
`;

/**
 * Creates the keyword contract in the database and writes each passage as
 * elt does: one part, at seq 0, of the source `doc-<id>` unless the passage
 * names its source, and its keywords row.
 */
export function writeKeywordContract(
  database: DatabaseSync,
  passages: readonly KeywordPassage[],
): void {
  database.exec(keywordContractSchema);
  const part = database.prepare(
    'INSERT INTO docs_parts VALUES (?, 0, 0, ?, ?, ?)',
  );
  const keyword = database.prepare(
    'INSERT INTO docs_keywords (id, source, seq, text) VALUES (?, ?, 0, ?)',
  );
  for (const passage of passages) {
    const source = passage.source ?? `doc-${passage.id}`;
    part.run(
      source,
      passage.text.length,
      passage.text,
      passage.product ?? null,
    );
    keyword.run(passage.id, source, passage.text);
  }
}
