# Code copied from Meddit's evidence-db

`PgvectorKeywordRetriever`'s default matching, `{ strategy: 'frequency', dropTokensThreshold: 10 }`, drops the most frequent term of a query while fewer than the threshold of passages match ([ADR 0018](./adr/0018-each-keyword-retriever-matches-in-the-strongest-form-of-its-engine.md)). Meddit's label store already does this for its label sections. This package keeps its own copy, and does not share it with Meddit yet.

The reason is the Rule of Three. It counts places, not packages. This is the second place, so the code is copied, and it is extracted only when a third place needs it (backlog #5738, until a third consumer). Meddit's maintainer reconciles Meddit's retrieval packages with this one himself (backlog #5479), so no shared package is proposed. Until then, a fix in one copy is made in the other copy too, and the commit names both files.

The source is in the Meddit repository, `packages/evidence-db/src/postgres-label-store.ts`, as of Meddit commit `83f6697`. The copy is `packages/retrieval/src/postgres/postgres-match.ts` of this package.

## What was copied

| Meddit (`PostgresLabelStore`)                                                                                 | This package (`DropMostFrequent`)    |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `#lexemesRarestFirst`: the lexemes of `to_tsvector`, rarest first, by `pg_stats.most_common_elems` or a count | `#rarestFirst`, with `#counted`      |
| the relaxed AND of `#search` (`RELAX_BELOW` = 10): drop the most frequent lexeme while fewer sections match   | `retrieve` and its trial, `#matched` |
| the order: the question's lexemes a section holds first                                                       | `#ranked`                            |
| `allOf`: the AND of the lexemes as a tsquery, each quoted                                                     | `allOf` and `lexemeQuery`            |

## What changed, and why

- **The threshold is an option.** Meddit's `RELAX_BELOW` is a constant measured on its own sections (#5627). Here it is `dropTokensThreshold`, 10 when absent, under Typesense's name: the number depends on the corpus.
- **The terms of a query are lexemes or keywords.** Meddit reads only a text. Here each keyword of a `QueryBundle`'s `keywords` is one term, a `phraseto_tsquery`, and its frequency is the frequency of its rarest lexeme. A term that no passage holds is left out.
- **The table, column and configuration are the host's.** Meddit reads `label_section.search` in `english`. Here they come from the store and the `index` option, and the configuration is a bound parameter.
- **The statistics are read on the table that holds the column.** Meddit reads its table by name in `current_schema()`. Here the passages can be a view (elt serves them through one), and a view has no statistics, so the lookup follows the view's rule in `pg_depend` to the table whose column of that name it reads.
- **A count of an untracked lexeme is capped.** Meddit counts each lexeme that `pg_stats` does not track in full. Here each count stops at the list's smallest frequency times the rows: a lexeme the statistics do not track is rarer than every lexeme they track, so a higher count orders nothing differently. Without statistics a count is not capped.
- **Each step is a trial, and the ranking runs once.** Meddit ranks every step and keeps the step's own results. Here each step is `count(*)` of `LIMIT ceil(threshold)` over a materialized CTE of the AND and the call's filter, so Postgres plans the GIN index (ADR 0018), and only the last step is ranked.
- **The score is a number of the passage.** Meddit orders by the lexemes held, then `ts_rank_cd`, and returns no score. Here the score is the number of the terms a passage holds plus `ts_rank(column, OR of the terms, 33)` (ADR 0005), and a tie goes to the smaller id in byte order.
- **Meddit's groups and provenance stay in Meddit.** The groups of equal sections (its ADR 0015), the repackaged labels (its ADR 0011) and the reads of its section rows are about drug labels, not passages.

## Meddit's later fixes, not copied

Meddit fixed its copy after this package's design was measured. Each fix is a decision for the extraction, not a fix this copy has.

- **#5680, `WORDS_LIMIT`** (Meddit `426fa04`): a search keeps a question's 10 rarest lexemes, after Meilisearch's `words_limit`, so it takes at most 10 steps and counts at most 10 lexemes. Here a long question takes one step for each term and counts every untracked lexeme in one statement.
- **#5668, `jit = off`** (Meddit `2a33048`): a search runs in a transaction that sets `jit` off, since the plans' costs cross `jit_above_cost` and JIT compiles for longer than the statements run. This package has no transaction of its own: a `PostgresSession` is the host's.
- **#5644, the cost cap** (Meddit `2a33048` and `ce4ae79`): a step that matches more than `MAX_RANKED` (4,000) sections ranks none, and Meddit refuses the question with `SourceRefusedError`; each statement has a `statement_timeout`. Here the first step is not bounded, and a host bounds a call with its abort signal (ADR 0017). The row cap waits for a 2M-passage measurement (the paper of #5633, section 3.4).
