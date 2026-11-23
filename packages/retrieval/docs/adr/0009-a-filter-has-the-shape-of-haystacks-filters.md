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
