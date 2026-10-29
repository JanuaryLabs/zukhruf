# A query without a date range compares every document

A query gave the similarity of a vector to each document of a date range, and the range was required. The first consumers compare news, where each document has a publish date. A new consumer does not: a host stores one vector for each passage of the experience of a person, such as a role and its description, and a user types "who has done health-system reform?". A passage has no publish date. Its vector table has the columns `id` and `vector` only, so a query failed with `no such column: "published_at"`.

## Decision

The date range of a query is optional: `query(vector, range?)`. Without a date range, a query compares the vector with every document of the vector table, and it reads only `id` and `vector`. With a date range `{ from, to }`, a query keeps the documents published from `from` to `to`, as before. The other rules of ADR 0006 do not change.

ADR 0006 named `query` after the query of the vector stores. In the vector stores, a filter is optional:

| Store    | Query                                    | Filter                     |
| -------- | ---------------------------------------- | -------------------------- |
| Pinecone | `index.query(vector=...)`                | `filter` is optional       |
| Qdrant   | `query_points(query=...)`                | `query_filter` is optional |
| Chroma   | `collection.query(query_embeddings=...)` | `where` is optional        |

A filter on a date is metadata that the caller adds when it needs it. A query that names no filter compares every document.

## Considered Options

- **The host gives each passage a publish date, and queries a date range that holds all of them.** No change to the package is necessary, but the host invents a date that means nothing, and each query must name a range that holds every document.
- **A separate call, such as `queryAll(vector)`.** Two calls then have one rule with one difference, and the vector stores have one call.
- **The date range of `query` is optional.** This option was selected.

## Consequences

- A vector table of documents with no publish date supports a query without a date range. The other calls, `nearest`, `neighbourGraph`, `similarity` and a query of a date range, still read `published_at`.
- A query without a date range reads and decodes each vector of the table, with no index (ADR 0001). Measure it before a table of many thousand documents.
- The callers that give a date range do not change.
