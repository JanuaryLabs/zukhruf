# Each keyword retriever matches in the strongest form of its engine

Status: Accepted 2026-11-25 (backlog #5633, #5669).

Decision-makers: Ezz. He set the direction in #5633: "make the utmost use of each engine power instead of abstracting the functionality to support the lesser", and approved the paper of #5633 (`~/.agent-backlog/handoff/zukhruf-retrieval-matching/paper.md`). The leader tables and BEIR measurements of the paper decided the forms and defaults.

Supersedes in part:

- [ADR 0004](./0004-a-keyword-retriever-queries-the-keyword-index-that-elt-writes.md), Decision bullet 4 (the words join with `operator`, `'AND'` by default), the amendment of 2026-11-23 on Postgres for its `OR` and its ranking, the amendment of 2026-11-24 for the `operator?` of each constructor, and the amendment of 2026-11-24 on SQL Server for its default (`operator: 'AND'`) and for `top_n_by_rank`. The option shipped in #5669; the defaults and `top_n_by_rank` change in its later steps.
- [ADR 0013](./0013-a-query-is-a-string-or-a-query-bundle-with-a-text-for-each-kind-of-search.md), Decision: a keyword retriever "quotes each word of each keyword". Each keyword is one phrase in the syntax of its engine (#5669, step 4).

## Context and Problem Statement

ADR 0004 gave the three keyword retrievers one option, `operator: 'AND' | 'OR'`, with AND as the default, and one statement each. A natural-language question under AND finds nothing on most questions: on SciFact SQLite gave 284 empty answers of 300, Postgres 277, SQL Server 294. Under OR, SQLite ranks well (bm25 has IDF). Postgres cannot rank OR in time (on Meddit's production, every OR query over 2.08M sections passed 20 s) and ranks common words first (`ts_rank_cd` has no IDF). SQL Server's `CONTAINSTABLE` RANK has no IDF either, while its `FREETEXTTABLE` is a full BM25 that no option reached. `keywordsOf` split every keyword on white space for every engine, so no engine could match a phrase. One shared form held each engine to the weakest engine's power.

## Decision Drivers

- Each engine at its full power (Ezz, 2026-11-25).
- Quality on BEIR (SciFact, NFCorpus, TREC-COVID) by nDCG@10, and a bounded cost at the size measured.
- Leaders counted by mechanism: only a leader with the same mechanism counts for a form.
- An engine's options are its own type (make illegal states unrepresentable).

## Considered Options

1. Keep one shared `operator` and change its default to OR.
2. One shared progressive strategy for all engines (Meilisearch `matchingStrategy`).
3. Each retriever owns a matching option typed for its engine, with that engine's best measured form as its default.

## Decision Outcome

Chosen option 3. Option 1 keeps Postgres's unbounded OR and SQL Server's IDF-less RANK, and cannot reach `FREETEXT`. Option 2 lost on SQLite, where bm25 already ranks the rare words first: progressive gave 0.425 against OR's 0.689 on SciFact.

- The shared phase gives "which text": the `keywords` of a query bundle, each a whole keyword, or its `query`, a text (ADR 0013). How a keyword or a text becomes a match is each engine's. A keyword is one phrase in the engine's syntax; a text goes to the engine's tokenizer.
- Each constructor takes `matching`, a discriminated union of its own engine only. No shared matching type exists, so no option of one engine compiles on another, and each member holds only the fields that mean something for it. `operator` is removed, with no alias.
- `SqliteBM25Retriever` takes `matching?: SqliteMatching` = `{ operator: 'OR', cutoffFrequency? }` or `{ operator: 'AND' }` (Elasticsearch's names). Default `{ operator: 'OR', cutoffFrequency: 20_000 }`: bm25 OR, where a term in more than 20,000 passages only adds to the score of the passages that rarer terms find, and a query of only such terms runs as their AND (Elasticsearch `cutoff_frequency`, Lucene `CommonTermsQuery`, txtai `cutoff`). The count bounds the rows by construction, which SQLite needs because `node:sqlite` cannot interrupt a statement; below 20,000 passages it is plain OR.
- `PgvectorKeywordRetriever` takes `matching?: PostgresMatching` = `{ strategy: 'frequency', dropTokensThreshold? }` or `{ strategy: 'all' }` (Meilisearch `matchingStrategy`, Typesense `drop_tokens_threshold`). Default `{ strategy: 'frequency', dropTokensThreshold: 10 }`: AND of the lexemes of `to_tsvector`, dropping the most frequent (from `pg_stats.most_common_elems`) while fewer than 10 passages match; the score is the number of the query's lexemes held plus `ts_rank(index, OR of the lexemes, 33)`. `'all'` keeps the AND and `ts_rank_cd`. Postgres offers no OR: it cannot be ranked in time at scale, and its best normalization changes with the corpus.
- `SqlServerKeywordRetriever` takes `matching?: SqlServerMatching` = `{ predicate: 'FREETEXT' }` or `{ predicate: 'CONTAINS', operator: 'AND' | 'OR' }` (Microsoft's names). Default FREETEXT: `FREETEXTTABLE` over a text, `ISABOUT(FORMSOF(INFLECTIONAL, "…"), …)` over keywords, with `top_n_by_rank` = `topK` when the call has no filter, and none with a filter, since it cuts before the filter. It is derived, not an option, so no caller can set an illegal pair.
- A `cutoffFrequency` or `dropTokensThreshold` that is not a positive finite number, and any value outside the union from an untyped caller, is a `RangeError` in the constructor.
- Shared and unchanged: the `Retriever` port, keywords against query, higher is better ([ADR 0005](./0005-a-score-is-higher-for-a-better-passage.md)), the filter compiler ([ADR 0009](./0009-a-filter-has-the-shape-of-haystacks-filters.md)).
- No timeout option: a host bounds a search with `signal` (`AbortSignal.timeout`, [ADR 0017](./0017-every-async-port-takes-an-optional-abort-signal-and-a-composite-rejects-at-once-when-it-aborts.md)).

### Leaders, counted by mechanism

| Mechanism                                                                            | Leaders with this mechanism                                                                                                                                                                | Count                                    | Used for                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------- |
| OR of the terms, ranked by BM25                                                      | Lucene, Solr, Tantivy, Elasticsearch, OpenSearch, Bleve, Milvus, Pinecone, LanceDB, Turbopuffer, MongoDB, Azure, ParadeDB, Qdrant, Weaviate, LlamaIndex, LangChain, Haystack, Microsoft, … | 25 of 37 default to OR; all nine leaders | SQLite default                         |
| Common terms: rare terms find, common terms only score; only common terms run as AND | Lucene `CommonTermsQuery`, Elasticsearch `cutoff_frequency`, txtai `cutoff`                                                                                                                | 3                                        | SQLite's bound                         |
| Drop high-frequency terms from match and score                                       | Lucene `MoreLikeThis.maxDocFreq`                                                                                                                                                           | 1                                        | measured; lost                         |
| Bounded top-k OR in the index (block-max WAND, weakAnd)                              | Elasticsearch `match` since 7.3, Vespa `weakAnd`                                                                                                                                           | 2                                        | no engine here has it                  |
| AND first, drop the most frequent word while fewer than T match                      | Meilisearch `matchingStrategy: 'frequency'`; Typesense `drop_tokens_threshold`                                                                                                             | 1 + 1                                    | Postgres default                       |
| AND first, drop by position                                                          | Meilisearch `'last'`, Typesense `drop_tokens_mode`, Algolia `removeWordsIfNoResults`                                                                                                       | 3                                        | not used: word order is not importance |
| A minimum share of terms                                                             | Elasticsearch/OpenSearch `minimum_should_match`, Solr `mm`, Weaviate `minimumOrTokensMatch`, Manticore quorum, RAGFlow `min_match`                                                         | 6                                        | not used: on Postgres it costs like OR |
| The engine's own natural-language predicate                                          | SQL Server `FREETEXT` / `FREETEXTTABLE`                                                                                                                                                    | 1 (the engine)                           | SQL Server default                     |
| A row cap on ranked hits in the engine                                               | SQL Server `top_n_by_rank`; Postgres `gin_fuzzy_search_limit`                                                                                                                              | 2                                        | SQL Server, with no filter             |
| A time cap that answers partial results                                              | Meilisearch `searchCutoffMs`, Elasticsearch `timeout`, RediSearch `ON_TIMEOUT RETURN`                                                                                                      | 3                                        | not used: `signal`                     |

### Measured (nDCG@10; TREC-COVID latency median / p95)

SQLite FTS5, porter unless marked; 4x is TREC-COVID repeated four times (685,328 passages):

| Form                                 | SciFact | NFCorpus | TREC-COVID | 4x ms       |
| ------------------------------------ | ------- | -------- | ---------- | ----------- |
| AND, unicode61 (the old default)     | 0.018   | 0.192    | 0.075      | —           |
| AND                                  | 0.047   | 0.206    | 0.107      | 16 / 78     |
| OR bm25, unicode61                   | 0.662   | 0.304    | 0.531      | —           |
| OR bm25                              | 0.689   | 0.318    | 0.582      | 597 / 1,190 |
| progressive T10                      | 0.425   | 0.261    | 0.296      | 62 / 112    |
| common terms, cutoff 20,000 passages | 0.689   | 0.318    | 0.527      | 154 / 263   |

Postgres 18.7:

| Form                                         | SciFact | NFCorpus | TREC-COVID | TREC-COVID ms  |
| -------------------------------------------- | ------- | -------- | ---------- | -------------- |
| AND, `ts_rank_cd` (the old default)          | 0.070   | 0.206    | 0.270      | 4.7 / 55       |
| OR, `ts_rank_cd`                             | 0.305   | 0.236    | 0.146      | 8,421 / 20,002 |
| OR, `ts_rank(…, 1)`                          | 0.604   | 0.304    | 0.245      | about 30 s     |
| progressive T10, `pg_stats`, `ts_rank(…, 1)` | 0.518   | 0.295    | 0.430      | 14 / 34        |

SQL Server 2022 with FTS, emulated amd64 (read the ratio to AND):

| Form                                 | SciFact | NFCorpus | TREC-COVID | TREC-COVID ms (× AND)  |
| ------------------------------------ | ------- | -------- | ---------- | ---------------------- |
| CONTAINSTABLE AND (the old default)  | 0.018   | 0.189    | 0.068      | 19 / 31 (1.0 / 1.0)    |
| CONTAINSTABLE OR                     | 0.269   | 0.238    | 0.045      | 197 / 236 (10.2 / 7.7) |
| FREETEXTTABLE, no `top_n_by_rank`    | 0.686   | 0.328    | 0.518      | 197 / 292 (10.2 / 9.5) |
| FREETEXTTABLE, `top_n_by_rank` = 100 | 0.686   | 0.328    | 0.518      | 66 / 131 (3.4 / 4.3)   |

### Consequences

- Good: on SciFact the defaults go from 0.070 to 0.518 nDCG@10 on Postgres, from 0.018 to 0.686 on SQL Server, and on SQLite from 0.018 to 0.662 on elt's unicode61 index (0.047 to 0.689 with porter); every default stays bounded at the size measured.
- Good: a host's keyword is matched as a phrase on every engine.
- Bad: the three defaults are three different forms, so the same question gives different passages on different engines. That was already true of their rankings.
- Bad: a breaking change of the constructors (`operator` is gone). No caller outside the package passed it.
- Neutral: Postgres's drop-the-most-frequent has a second copy in Meddit's evidence-db, recorded in a ledger when it lands (strike 2).

### Confirmation

- Each engine's black-box tests on a real engine, each with a mutation that it catches.
- The BEIR probe re-run through each retriever gives the paper's numbers within noise.

Shipped so far (#5669, step 3): the option. `SqliteBM25Retriever` takes `matching?: { operator: 'OR' } | { operator: 'AND' }`, `PgvectorKeywordRetriever` takes `matching?: { strategy: 'all' }`, and `SqlServerKeywordRetriever` takes `matching?: { predicate: 'CONTAINS', operator: 'AND' | 'OR' }`; each is exported from its engine's entry point. The defaults stay AND on every engine until the later steps change them. Postgres's OR is removed with its test. An untyped caller's value outside the union is a `RangeError` when the retriever is made. `type-tests/published-types.ts` proves against `dist` that the old `operator`, another engine's matching, `cutoffFrequency` with `AND`, `dropTokensThreshold` or an `operator` with Postgres's `'all'`, and `CONTAINS` without its operator do not compile. Step 4: each keyword of `keywords` is one phrase, an FTS5 phrase on SQLite, `phraseto_tsquery` on Postgres and a CONTAINS phrase on SQL Server, so `'heart failure'` matches those words side by side and in order, and FTS5, tsquery and CONTAINS syntax inside a keyword stays text; a text is still matched by its white-space words, each one phrase on SQLite and SQL Server and one `plainto_tsquery` on Postgres, until the later steps give it to each engine's tokenizer. Step 5: SQLite's OR member takes `cutoffFrequency`, a count of passages (1 or more) or a share of them (under 1), and the default is `{ operator: 'OR', cutoffFrequency: 20_000 }`. Each term's frequency is a trial of its own phrase, `count(*)` of `MATCH … LIMIT cutoff + 1`. A term that no passage holds is left out. The FTS5 query is `(rare OR) AND (all OR)`, or the AND of the terms when none is rare. Measured through the retriever (porter, topK 100): SciFact 0.686 and NFCorpus 0.317 (equal to OR), TREC-COVID 0.545 (OR 0.585). It is above the paper probe's 0.527 because the retriever drops the words that no passage holds. At 4x the p95 was 200 and 247 ms in two runs, against OR's 1,190 ms. The exact two-statement form gave OR's quality (0.585 at 1x, 0.266 at 4x against 0.221) but was slower at 4x (p95 260 and 338 ms), so it is not used. Still to ship, one step each: Postgres `'frequency'` and its default; SQL Server `FREETEXT` and its default with `top_n_by_rank`.
