# A vector search reads a vector table of unit vectors

A collection embeds documents, stores their vectors in its table `embedding_document`, and searches that table. Other programs also store vectors. For example, elt computes vectors for the rows of a source and writes them into a SQLite table that elt owns. Such a program must not copy its vectors into a collection only to search them.

Thus `VectorSearch` does the search, and the collection does not. `new VectorSearch({ database, table })` searches a vector table: a table or a view with the columns `id`, `vector` and `published_at`. A collection makes a `VectorSearch` over `embedding_document` and gives its `nearest`, `neighbourGraph` and `similarity` calls to it. Thus the search of a collection and the search of another vector table have one implementation and the same results. Other vector stores also keep the search apart from the storage. The distance operators of pgvector (`<=>`, `<#>`) and the distance functions of sqlite-vec (`vec_distance_cosine`) work on a vector column of any table.

## The vectors must be unit vectors

The search calculates a similarity as the dot product of two vectors, with `dot` of `@zukhruf/vectors`. The dot product is the cosine only when the two vectors are unit vectors. Thus each vector in a vector table must be a unit vector. The program that writes the table normalizes each vector before it writes it. The search does not normalize a vector, and it does not examine the length of a vector.

FAISS has the same rule. Its flat inner-product index (`IndexFlatIP`) gives the cosine only when the caller normalizes the vectors first, with `faiss.normalize_L2`.

## Considered Options

- **The search normalizes each vector when it decodes it.** Then a vector table can contain vectors of any length. But a collection already stores unit vectors. When the search normalizes a float32 unit vector again, the values can change in the last bit. Then a similarity can change a small quantity, and two documents with equal similarities can change their order. The result of a collection must not change.
- **The search examines the length of each vector and throws an error.** Each decode then needs one more pass over the vector. The writer of the table has the vectors before the search, so the writer can normalize them.
- **The search requires unit vectors.** This option was selected.

## Consequences

- A collection gives the same results as before.
- A program that writes a vector table normalizes each vector, and stores it as float32 values, little-endian, as a collection does with `toSql` of `@zukhruf/vectors/sqlite`. The search reads each BLOB with `fromSql` of the same module. Little-endian is the byte order of each platform that Node runs on, so a table written in the byte order of the platform before this change reads the same.
- A vector that is not a unit vector gives an incorrect similarity, and the search does not tell it.
- All vectors of one vector table must have one dimension (ADR 0003). The search does not examine the dimension before it compares, but `dot` of `@zukhruf/vectors` throws the `DimensionMismatchError` of that package for two vectors of other dimensions. A collection throws the same class.
- The search prepares its statements on each call. Thus the table or the view can come after the `VectorSearch`. A name that SQLite cannot find gives the SQLite error of that call.

## Amendment (#4694)

A collection makes each vector a unit vector with `UnitVector.normalize` of `@zukhruf/vectors`. It rounds the values of the model to float32 and divides them by their length in float64, as pgvector does (ADR 0003 of `@zukhruf/vectors`). Before, the collection divided the values in float64 and rounded once. Thus a vector that a collection stores now can differ in the last bit from the vector it stored before for the same text. The two stay comparable, to about one float32 step, and no document must be embedded again. The search still does not normalize a vector that it reads, so its result for a given vector table does not change.
