# Embeddings

A program that compares texts by meaning needs one vector for each text. A model makes the vector, and the call to the model is the slow part. This package keeps the vectors of documents in a SQLite database, calls the model only for new or changed text, and finds the nearest documents of a document.

## Language

**Collection**:
The documents and their vectors in one SQLite database. All vectors of a collection have one dimension. A collection keeps its vectors in a vector table.
_Avoid_: Index, store, table

**Vector table**:
A SQLite table or view with the columns `id` (text) and `vector` (a unit vector as a BLOB of float32 values, little-endian, as `toSql` of `@zukhruf/vectors/sqlite` writes it). Each call except a query without a date range also reads `published_at` (milliseconds since the Unix epoch). Each row is one document. The table of a collection is a vector table. Another program can write its own vector table.
_Avoid_: Index, store, collection (for a table that no collection writes)

**Vector search**:
The search for the neighbours of a document, or for the similarities of a query, in one vector table. It does not embed and does not write.
_Avoid_: Index, retriever

**Document**:
An id, a text and a publish date that the caller gives. The collection stores the vector of the text, not the text. In a vector table, a document is a row.
_Avoid_: Article, chunk, record

**Publish date**:
The date of a document that the caller gives as `publishedAt` (a `Date`). A vector table keeps it in the column `published_at`, in milliseconds since the Unix epoch. A window and a date range select documents by their publish date (`src/collection.ts`, `src/vector-search.ts`).
_Avoid_: Timestamp, created date

**Model**:
The AI SDK embedding model that makes a vector from a text. A provider and a model id name it.
_Avoid_: Embedder, encoder

**Vector**:
The list of numbers that the model gives for a text. The collection stores it with a length of 1 (a unit vector), as float32 values.
_Avoid_: Embedding (for the stored value), tensor

**Unit vector**:
A vector divided by its length, so its length is 1, as `UnitVector.normalize` of `@zukhruf/vectors` makes it. The collection stores the unit vector of each text, and a query makes a unit vector of the vector that the caller gives. A vector search requires that each vector of a vector table is a unit vector and does not examine its length (`src/collection.ts`, `src/vector-search.ts`, [ADR 0005](docs/adr/0005-a-vector-search-reads-a-vector-table-of-unit-vectors.md)).
_Avoid_: Normalized vector

**Embedding cache**:
The cache of `@zukhruf/embedding-cache` that the collection embeds through. It keeps the vector of each text that the model embedded in the table `embedding_cache` of the database of the collection, so an upsert calls the model only for a new or changed text. A delete does not remove a vector from the embedding cache, so an upsert of the same text after a delete calls no model (#3134, commit ba803520, `src/collection.ts`, [ADR 0002](docs/adr/0002-the-hash-includes-the-model.md)).
_Avoid_: Collection, vector table (the embedding cache keeps the vectors of texts, not of documents), hash

**Dimension**:
The number of values in a vector.
_Avoid_: Size, length (length is the norm of a vector)

**Similarity**:
The cosine of the angle between two vectors, from -1 to 1. For unit vectors, it is their dot product.
_Avoid_: Distance, score

**Window**:
The documents whose publish date is at most a number of days before or after the publish date of a document.
_Avoid_: Range, period

**Date range**:
The documents whose publish date is from a date `from` to a date `to`, both included. The caller gives it as `{ from, to }` to a query and to a neighbour graph. A window is around the publish date of one document; a date range is the same for all documents of a call (`src/collection.ts`, `src/vector-search.ts`).
_Avoid_: Window, period

**Neighbour**:
A document in the window of a document, with its similarity to that document. The document is not its own neighbour.
_Avoid_: Match, hit, result

**Query**:
The similarity of a vector that the caller gives, not a stored document, to each document, or to each document of a date range. The caller embeds the text of the query with its model.
_Avoid_: Search (for a query), lookup

**Neighbour graph**:
The k nearest neighbours of each document published in a date range. For each document, they are the result of a search of that document.
_Avoid_: Batch search, kNN matrix
