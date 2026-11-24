# A filter has the shape of Haystack's filters

Status: accepted by Ezz on 2026-11-23 ("Approve, write the paper").

Most leaders give a structured filter of AND, OR and NOT over comparisons. Haystack: `{ operator: "AND" | "OR" | "NOT", conditions }` and `{ field, operator, value }` with `== != > >= < <= in "not in"` ([metadata filtering](https://docs.haystack.deepset.ai/docs/metadata-filtering)). LlamaIndex: `MetadataFilters { filters, condition }` with more operators ([vector_stores/types.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/vector_stores/types.py)). Qdrant: `filter { must, should, must_not }` ([Qdrant search](https://qdrant.tech/documentation/search/search/)). .NET takes a LINQ expression ([vector search](https://learn.microsoft.com/en-us/dotnet/ai/vector-stores/vector-search)); Mastra takes MongoDB operators.

## Decision

- `Filter` is `{ operator: 'AND' | 'OR' | 'NOT', conditions: Filter[] }` or `{ field, operator: '==' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'not in', value }`.
- `field` is a field of `Passage` (`source`, `seq`, `start`, `end`) or a metadata column, written `metadata.<column>`, as Haystack writes `meta.<key>`.
- An engine retriever turns the filter into a SQL `WHERE` with parameters, in the query of the search.

## Considered Options

- **A callback over a passage.** It lost: SQL cannot run it, so the engine must give every row first.
- **LlamaIndex's longer operator list.** It lost: `text_match`, `contains` and `any` mean other things on each engine; the Haystack set maps to SQL on SQLite, Postgres and SQL Server.
- **Qdrant's `must` / `should` / `must_not`.** It lost: only Qdrant uses it; AND / OR / NOT is the common form.

## Amendment 2026-11-23

Accepted by Ezz on 2026-11-23 ("They stand"). A filter keeps Haystack's meaning of a missing value, as Haystack's pgvector store writes it in SQL ([filters.py](https://raw.githubusercontent.com/deepset-ai/haystack-core-integrations/main/integrations/pgvector/src/haystack_integrations/document_stores/pgvector/filters.py)): `==` with `null` selects NULL (SQLite `IS`), `!=` keeps NULL (`IS NOT`, pgvector's `IS DISTINCT FROM`), and `not in` keeps NULL (`IS NULL OR NOT IN`). A `metadata.<column>` field is one quoted identifier, and each value is a parameter; a boolean value is 1 or 0 on SQLite, which has no boolean. An empty `AND` selects every passage and an empty `OR` none. A field that is not a passage field or `metadata.<column>`, or an `in` / `not in` value that is not an array, fails the call with a `TypeError`; a column that the passages do not have fails with the error of the engine.

## Amendment 2026-11-23: the filter on Postgres

Accepted by Ezz on 2026-11-23 ("They stand"). Postgres has a boolean, so a boolean value compares with a boolean column, not as 1 or 0. Postgres refuses an empty list, `IN ()`, so an empty `in` selects no passage and an empty `not in` every passage, as on SQLite. A value is a string, a number, a bigint, a boolean or null; each value is a positional parameter, `$n`.

## Amendment 2026-11-24: the filter on SQL Server

Accepted by Ezz on 2026-11-24 ("They stand"). The SQL is the Postgres SQL: `==` is `IS NOT DISTINCT FROM` and `!=` is `IS DISTINCT FROM`, which T-SQL has since SQL Server 2022, and `not in` is `IS NULL OR NOT IN`. T-SQL has no `TRUE` or `FALSE` condition, so an empty `AND`, an empty `not in` and no filter are `1 = 1`, and an empty `OR` and an empty `in` are `1 = 0`; T-SQL refuses `IN ()`. Each value is a named parameter, `@pN`; a boolean stays a boolean, which the driver binds as a `BIT`, and a `bigint` value binds as an exact `BIGINT` (probe P6). A string compares in the collation of its column, usually case-insensitive.
