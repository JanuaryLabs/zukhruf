# Query, fetch, delete and count follow the vector stores

A collection could only compare two stored documents. Two consumers need more:

- Relevance filtering (#3195) compares each article with the vector of one sentence, the description of a profile. The sentence is not a document. If the host stores it as a document, event grouping sees it as a report of the window.
- A search by description (#3155) needs the documents that are most similar to the vector of a text that the user types.

A host also needs to read a stored vector, remove a document, and know the size of the collection. The user chose the four calls on 2026-10-29. Their names and their rules come from the top vector stores, so that a reader who knows one of them knows this package.

| Call                          | Pinecone                  | Qdrant                             | Chroma                                   |
| ----------------------------- | ------------------------- | ---------------------------------- | ---------------------------------------- |
| `query(vector, { from, to })` | `index.query(vector=...)` | `query_points(query=...)`          | `collection.query(query_embeddings=...)` |
| `fetch(ids)`                  | `index.fetch(ids)`        | `retrieve(ids, with_vectors=True)` | `get(ids, include=["embeddings"])`       |
| `delete(ids)`                 | `index.delete(ids)`       | `delete(points_selector=...)`      | `collection.delete(ids)`                 |
| `count()`                     | `describe_index_stats()`  | `count()`                          | `collection.count()`                     |

## Decision

**`query(vector, { from, to })`** gives the similarity of the vector to each document published from `from` to `to`, with the two edges in the range. The call makes the vector a unit vector first, so a vector of any length gives the cosine. The result has every document of the range, with the highest similarity first. Equal similarities sort by id, as in `nearest`. The vector stores give the nearest first too. A caller that needs the k nearest takes the first k entries. A caller that needs the similarity of each document, as relevance filtering does, reads all entries.

The vector must have the dimension of the stored vectors (ADR 0003). Another dimension is a `DimensionMismatchError`, with the stored dimension as `expected` and the dimension of the vector as `actual`. A collection with no document gives an empty result. `VectorSearch` also has `query`, with the same rules, because a query is a search of a vector table (ADR 0005).

**`fetch(ids)`** gives a `Map` from each id to its stored unit vector, as a `Float32Array`, in the order of the ids. The vector is a copy, so a change to it does not change the collection. One id that the collection does not store fails the whole call with an `UnknownDocumentError`. This is the rule of `nearest` and `similarity`. Pinecone and Chroma leave out an unknown id instead. Here a caller that asks for an id expects its vector, as a caller of `similarity` does. A silent gap moves the error to a later line.

**`delete(ids)`** removes the documents. An id that the collection does not store is not an error. Thus a second delete of the same ids does nothing, and a retry is safe. Pinecone and Chroma do the same. After a delete, an upsert of the same id and text calls the model again, because the stored hash is gone.

**`count()`** gives the number of stored documents.

## Considered Options

- **`vectorOf(id)`, one vector for one id.** This was the first proposal for relevance filtering. `fetch(ids)` does the same for one id or many, and has the name of the vector stores.
- **The host stores the description as a document.** No new call is necessary, but the description then is a report for event grouping, and a neighbour in each search.
- **`query` with a `k`.** Pinecone requires `topK`. Relevance filtering needs the similarity of every article of the stream, so a `k` must then be the size of the range. The caller can cut the result.
- **The four calls with the rules of the vector stores.** This option was selected.

## Consequences

- A host can search by a text that is not a document: it embeds the text with its model and calls `query`. The package does not embed the query text, because the text of a query often needs another prompt than the text of a document (EmbeddingGemma uses `task: search result | query: …`).
- `query` reads and decodes each vector of the range, with no index (ADR 0001).
- `DimensionMismatchError` now also comes from `query`. Its message names both causes.
