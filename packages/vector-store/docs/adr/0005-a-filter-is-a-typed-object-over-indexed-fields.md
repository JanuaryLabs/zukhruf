# A filter is a typed object over indexed fields

Status: proposed, for Ezz's review (2026-11-18).

The consumers filter in three ways: `@deepagents/retrieval` on the equality of a source and of a document, `@zukhruf/embeddings` on a range of publish dates, and datahub's OpenAI vector stores on the equality of attributes.

## Considered Options

| Tool                     | Filter                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------- |
| .NET VectorData          | A LINQ expression; the Postgres connector lists `==`, `!=`, `&&`, `Contains` and `Any` |
| Mastra                   | Operators after MongoDB, on any key of the metadata                                    |
| LangChain.js             | `filter?: this["FilterType"]`, a type of each store                                    |
| LangChainGo              | `WithFilters(filters any)`                                                             |
| SQL text from the caller | none of the leaders; it would tie the host to one engine's SQL                         |

TypeScript has no expression trees, so a LINQ form is not possible. An untyped object, as in Mastra and LangChain, moves each error to the search.

## Decision

- A filter is an object whose keys are indexed fields of the definition. The fields of one filter must all hold (and).
- A field takes a value (equal), `{ in: [...] }`, or a range `{ gt?, gte?, lt?, lte? }` for `integer`, `real` and `date`.
- No or, no not, and no SQL text in the first release. Each engine compiles the filter to parameters; no value is written into the SQL text.
- The same filter serves `search`, `count` and `delete({ filter })`.

## Consequences

- The three ways of the consumers have a form. An "or" waits for a consumer that needs it.
- The type of the definition gives the type of the filter, so a filter on a payload or on a missing field does not compile.
