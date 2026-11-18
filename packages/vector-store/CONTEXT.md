# Vector store

A program that finds records by meaning keeps a vector for each record and asks a database for the records nearest to a vector. This package gives one interface for that over SQLite, sqlite-vec, Postgres with pgvector, and SQL Server. The words below have one meaning each in its documents.

## Language

**Vector store**:
The object that reaches one database through one engine and gives its collections. `SqliteVectorStore`, `SqliteVecVectorStore`, `PostgresVectorStore` and `SqlServerVectorStore` are vector stores.
_Avoid_: Database, client, provider

**Engine**:
The kind of database and the way that the package keeps vectors in it: plain SQLite, sqlite-vec, Postgres with pgvector, or SQL Server. Each engine is one subpath of the package.
_Avoid_: Backend, adapter, connector, driver

**Session**:
The few methods of a database connection that one engine calls. The caller makes the session from its own driver. The package imports no driver.
_Avoid_: Connection, pool, client

**Collection**:
The records of one definition in one database, kept in one table. All vectors of a collection have the dimensions of its definition.
_Avoid_: Index, table, namespace

**Definition**:
The shape of the records of a collection: the type of the key, the data fields, and the vector with its dimensions and its distance.
_Avoid_: Schema, model, mapping

**Record**:
A key, its data and its vector. A collection has one record for each key.
_Avoid_: Document, row, point, item

**Key**:
The value that names one record in its collection. A text or an integer.
_Avoid_: Id, primary key

**Data field**:
A named value of a record that is not its key or its vector, for example a source or a publish date. A data field is indexed or a payload.
_Avoid_: Metadata, attribute, property

**Indexed field**:
A data field that a filter can name. Each engine keeps it in a column that a `WHERE` reads.
_Avoid_: Filterable field, metadata column

**Payload**:
A data field that the collection keeps and gives back, and that no filter can name.
_Avoid_: Auxiliary column, metadata

**Distance**:
How far one vector is from another: `cosine` (1 − the cosine similarity), `dot` (the negative dot product) or `euclidean`. A lower distance is nearer.
_Avoid_: Score, similarity, metric

**Search**:
The records nearest to a vector, at most `top` of them, from the records that the filter keeps, the nearest first.
_Avoid_: Query, similarity search, retrieval

**Filter**:
Conditions on indexed fields that a record must meet to be in a search, a count or a delete.
_Avoid_: Where, predicate, metadata filter

**Embedding collection**:
A collection that keeps text records and makes each vector with an embedding model. It calls the model only for a record whose content key changed.
_Avoid_: Document store, text collection

**Model**:
The AI SDK embedding model that makes a vector from a text. A provider and a model id name it.
_Avoid_: Embedder, encoder

**Content key**:
The sha256 of the JSON array of the model's provider, the model id and the text. A new text or a new model gives a new content key.
_Avoid_: Hash, cid, checksum

**Unit vector**:
A vector divided by its length, so its length is 1. The cosine of two unit vectors is their dot product.
_Avoid_: Normalized vector
