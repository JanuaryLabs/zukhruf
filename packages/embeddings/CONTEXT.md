# Embeddings

A program that compares texts by meaning needs one vector for each text. A model makes the vector, and the call to the model is the slow part. This package keeps the vectors of documents in a SQLite database, calls the model only for new or changed text, and finds the nearest documents of a document.

## Language

**Collection**:
The documents and their vectors in one SQLite database. All vectors of a collection have one dimension. A collection keeps its vectors in a vector table.
_Avoid_: Index, store, table

**Vector table**:
A SQLite table or view with the columns `id` (text), `vector` (a unit vector as a BLOB of float32 values, in the byte order of the platform) and `published_at` (milliseconds since the Unix epoch). Each row is one document. The table of a collection is a vector table. Another program can write its own vector table.
_Avoid_: Index, store, collection (for a table that no collection writes)

**Vector search**:
The search for the neighbours of a document in one vector table. It does not embed and does not write.
_Avoid_: Index, query, retriever

**Document**:
An id, a text and a publish date that the caller gives. The collection stores the vector of the text, not the text. In a vector table, a document is a row.
_Avoid_: Article, chunk, record

**Model**:
The AI SDK embedding model that makes a vector from a text. A provider and a model id name it.
_Avoid_: Embedder, encoder

**Vector**:
The list of numbers that the model gives for a text. The collection stores it with a length of 1 (a unit vector), as float32 values.
_Avoid_: Embedding (for the stored value), tensor

**Dimension**:
The number of values in a vector.
_Avoid_: Size, length (length is the norm of a vector)

**Hash**:
The sha256 of the provider, the model id and the text. When the hash of a document did not change, an upsert does not call the model.
_Avoid_: Content id, cid, checksum

**Similarity**:
The cosine of the angle between two vectors, from -1 to 1. For unit vectors, it is their dot product.
_Avoid_: Distance, score

**Window**:
The documents whose publish date is at most a number of days before or after the publish date of a document.
_Avoid_: Range, period

**Neighbour**:
A document in the window of a document, with its similarity to that document. The document is not its own neighbour.
_Avoid_: Match, hit, result

**Neighbour graph**:
The k nearest neighbours of each document published in a date range. For each document, they are the result of a search of that document.
_Avoid_: Batch search, kNN matrix
