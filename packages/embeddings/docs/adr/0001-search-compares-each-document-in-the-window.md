# A search compares each document in the window, with no index

A search gives the nearest neighbours of a document. A vector index, such as HNSW in sqlite-vec or pgvector, finds neighbours fast in a large collection. But an index gives approximate results: it can miss a near document, and its result can change with the order of the inserts. An index also needs a SQLite extension that each connection must load.

The first consumer compares a document only with documents published near it. The research for event detection used a window of 7 days and 80 neighbours. In a window, the number of documents is small. Thus `nearest` reads each document in the window, calculates the similarity of each one, and sorts them. Equal similarities sort by id, so two calls on the same collection give the same result. FAISS does the same in its flat index (`IndexFlatIP`): an exact search over all vectors. The FAISS guidelines to choose an index name the flat index when the results must be exact.

The publish date has a B-tree index, so SQLite reads only the rows of the window.

## Considered Options

- **sqlite-vec with a `vec0` table.** deepagents uses it. Its search is exact, but it needs the extension on each connection, and `@zukhruf/sqlite-drift` must then make the table in a database with the extension.
- **An approximate index (HNSW).** It is fast on millions of vectors. Its result is not exact and not deterministic.
- **An exact search inside the window, in JavaScript.** This option was selected.

## Consequences

- The result of `nearest` is exact and deterministic.
- The cost of `nearest` grows with the number of documents in the window, times the dimension. A wide window on a large collection is slow. Measure it before you use a window of many thousand documents.
- The package needs no SQLite extension.
