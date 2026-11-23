# A keyword retriever queries the keyword index that elt writes

Status: accepted by Ezz on 2026-11-23 ("Index in elt, query in retrieval").

Five or more places run FTS5 BM25 by hand, each with its own way to quote the words of the user: text2sql `toFtsQuery` (#5410), its google-tasks copy, datahub search (#3451), and deepagents `ContextStore.searchMessages` on three engines (#4884, #5417). `ContextStore` ranks with FTS5, `ts_rank` and `CONTAINSTABLE`, and its score direction differs across the engines (#4884). SQLite FTS5 `bm25()` is negative: "the better the match, the numerically smaller" ([FTS5](https://www.sqlite.org/fts5.html)). elt core has no search, and its README leaves FTS5 to the app (`packages/elt/README.md:704` in the elt repository).

## Decision

- elt writes the keyword index over the passages (#5401). This package only queries it.
- Each engine has a keyword retriever: `SqliteBM25Retriever` (FTS5 `bm25()`), `PgvectorKeywordRetriever` (Postgres full-text search with `ts_rank_cd`, [pgvector README](https://github.com/pgvector/pgvector/blob/master/README.md); Haystack's name) and `SqlServerKeywordRetriever` (full-text).
- Every keyword retriever gives one score direction: higher is better. `SqliteBM25Retriever` negates `bm25()`.
- The retriever quotes each word of the query, as text2sql's `toFtsQuery` does (#5410), so a word of the user is never an FTS operator. The words join with `operator`, `'AND'` (the default, the implicit operator of FTS5) or `'OR'`; the hosts differ in this, so it is an option.

## Considered Options

- **The package also writes the keyword index.** It lost: Ezz ruled "Index in elt, query in retrieval". Haystack also builds BM25 at write time.
- **Give the value of the engine's ranking function (such as `bm25()`) as it is.** It lost: a fusion or a cutoff then needs to know the engine, and #4884 is the bug that this causes.

## Consequences

- text2sql (#5410), datahub (#3451) and deepagents `ContextStore` (#5417) move to the keyword retrievers.
- The keyword index has to cover the same passage ids as the vectors, so a fusion of both joins on `Passage.id`.

## Amendment 2026-11-23

Accepted by Ezz on 2026-11-23: the key ("Integer key on passages"), the tie and the empty query ("They stand"). On SQLite the passages relation has an integer `rowid`: a rowid table has it natively, and a view exposes an integer column `AS rowid`. The keyword index is an FTS5 table with the passages as its external content and FTS5's default `content_rowid`: `CREATE VIRTUAL TABLE <index> USING fts5(text, content = '<passages>')`, which elt fills with the `'rebuild'` command or with triggers ([FTS5 external content](https://www.sqlite.org/fts5.html#external_content_tables); text2sql's backlog index and Alex Garcia's hybrid recipe join the same way). `SqliteBM25Retriever` joins `p.rowid = <index>.rowid`, the same SQL for a table and a view. The `rowid` is the key of the index, not a metadata column of a passage. A tie of `bm25()` goes to the smaller passage id. A query of no words gives no passages, because FTS5 refuses an empty `MATCH`.
