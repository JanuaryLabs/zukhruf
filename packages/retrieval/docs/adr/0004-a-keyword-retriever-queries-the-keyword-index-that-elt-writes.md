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

## Amendment 2026-11-23: the keyword index on Postgres

Accepted by Ezz on 2026-11-23: the configuration option ("Option, default english (Recommended)") and the index column, the query form and the score ("They stand"). The paper says "`tsvector` with a GIN index" and leaves three details open. S6 takes the form that most leaders use:

- **The index is a `tsvector` column of the passages.** `index` names the column. elt writes it as `GENERATED ALWAYS AS (to_tsvector('english', text)) STORED`, or with another configuration with a GIN index, and a passages view can give the column of its table. The pgvector README searches a column `textsearch` ([hybrid search](https://github.com/pgvector/pgvector/blob/master/README.md#hybrid-search), lines 638-639). LlamaIndex has the generated column `text_search_tsv` with a GIN index ([base.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-integrations/vector_stores/llama-index-vector-stores-postgres/llama_index/vector_stores/postgres/base.py), lines 179-199). LangChain reads a `tsv_column` when the table has one ([async_vectorstore.py](https://raw.githubusercontent.com/langchain-ai/langchain-postgres/main/langchain_postgres/v2/async_vectorstore.py), lines 728-731). Haystack keeps no column: it puts a GIN index on the expression `to_tsvector(language, content)` and repeats the expression in the query ([document_store.py](https://raw.githubusercontent.com/deepset-ai/haystack-core-integrations/main/integrations/pgvector/src/haystack_integrations/document_stores/pgvector/document_store.py), lines 57-59 and 496). The SQLite index stays a separate FTS5 table, because FTS5 has no column form.
- **`configuration` names the text search configuration, `'english'` when absent.** The query has to use the configuration of the index, so a host whose index has another configuration, such as `'simple'`, which keeps stop words and does not stem, gives its name. Each leader has this option with English as its default: Haystack `language = "english"` (line 91), LlamaIndex `text_search_config = "english"` (line 300), LangChain `tsv_lang = "pg_catalog.english"` ([hybrid_search_config.py](https://raw.githubusercontent.com/langchain-ai/langchain-postgres/main/langchain_postgres/v2/hybrid_search_config.py), line 203). The pgvector README uses the default configuration of the server. The configuration is a positional parameter cast to `regconfig`, never text in the SQL, so a name that is not a configuration fails the call and runs no SQL of its own.
- **Each word is one `plainto_tsquery($1::regconfig, $n)`.** The words join with `&&` for `AND` (the default) and `||` for `OR`. `plainto_tsquery` reads its text as plain text, so `&`, `|`, `!`, `<->`, `:*`, quotes and parentheses in a word are never operators: this is how the Postgres retriever quotes a word. Haystack (line 58), LangChain (line 726) and the pgvector README (line 638) give the whole query to one `plainto_tsquery`, which is the `AND` form. LlamaIndex is the only leader with `OR`: it removes the punctuation, joins the words with `|` and calls `to_tsquery` (lines 953-959). One `plainto_tsquery` for each word gives both operators without a change to the text of the user. The english configuration drops a stop word, so a query of stop words only gives no passages, and a stop word in an `AND` query does not stop a match.

The score is `ts_rank_cd`, as Haystack, LangChain and the pgvector README rank; LlamaIndex uses `ts_rank`. A tie goes to the smaller passage id in byte order (`COLLATE "C"`), the order of SQLite and of JavaScript, whatever the collation of the database is.
