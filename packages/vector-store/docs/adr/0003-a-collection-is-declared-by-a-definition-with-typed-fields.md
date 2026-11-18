# A collection is declared by a definition with typed fields

Status: proposed, for Ezz's review (2026-11-18).

A record has a key, data and a vector. The stores must know which data a filter can read, because each engine filters only on the columns that it can read in a `WHERE`.

## Considered Options

| Tool            | How a record's data is declared                                                                                                                                                                                                                                                  | Filter on it                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| .NET VectorData | [`VectorStoreCollectionDefinition`](https://learn.microsoft.com/en-us/semantic-kernel/concepts/vector-store-connectors/schema-with-record-definition), or the attributes `[VectorStoreKey]`, `[VectorStoreData(IsIndexed)]`, `[VectorStoreVector(Dimensions, DistanceFunction)]` | Only the data with `IsIndexed`                                                                    |
| Mastra          | `createIndex({ indexName, dimension, metric })`, and a free JSON `metadata` for each vector                                                                                                                                                                                      | Any key of the JSON                                                                               |
| LangChain.js    | `Document.metadata`, free JSON                                                                                                                                                                                                                                                   | Each store has its own `FilterType`                                                               |
| sqlite-vec      | [`vec0`](https://github.com/asg017/sqlite-vec/blob/main/site/features/vec0.md) has metadata columns, partition keys and auxiliary (`+`) columns                                                                                                                                  | Metadata columns "can be included in the `WHERE` clause of a KNN query"; auxiliary columns cannot |

A free JSON blob lets a filter name a key that no engine can read in an index, and the error comes at the search. sqlite-vec draws the same line as .NET: some fields are filterable, the others are only carried.

## Decision

- A `CollectionDefinition` has a key type (`text` or `integer`), data fields, and one vector with its `dimensions` and its `distance`.
- A data field has a type: `text`, `integer`, `real`, `boolean`, `date`, or `json`. A scalar field with `indexed: true` is an indexed field: a column that a filter can read. Every other field is a payload. A `json` field is always a payload; the type of the definition refuses `indexed` on it.
- Each engine keeps each field in a column of its own type: an indexed field of sqlite-vec is a metadata column, and a payload is an auxiliary column.
- The types of the records, of the filter and of the results come from the definition. A filter that names a payload does not compile ([ADR 0005](./0005-a-filter-is-a-typed-object-over-indexed-fields.md)).

## Consequences

- The free `metadata` of `@deepagents/retrieval` becomes a payload of type `json`. Its `source_id` and `document_id` become indexed fields.
- A new indexed field is a new definition, so `ensure()` reports it ([ADR 0008](./0008-ensure-creates-the-collection-and-a-changed-definition-is-an-error.md)).
