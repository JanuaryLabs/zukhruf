# All vectors of a collection have one dimension

The similarity of two vectors needs the same dimension. Two models can give different dimensions, for example 768 and 1024. A collection with vectors of two dimensions gives no correct similarity.

Thus an upsert compares the dimension of each new vector with the dimension of one stored vector that the upsert does not replace. When the dimensions differ, the upsert throws `DimensionMismatchError`, and the transaction stores none of its documents. When the upsert replaces all documents, it can change the dimension.

The collection does not store the dimension apart from the vectors. The length of a stored BLOB gives the dimension.

The collection makes its table with `@zukhruf/sqlite-drift`, with `rows: 'replace'`. Each row comes from a document of the caller and the model. When a new release changes the table, the table is made again without rows, and the next upsert of the caller fills it again.

## Consequences

- A vector of a different dimension cannot go into a collection that keeps other vectors.
- A change to a model with a different dimension needs one upsert of all documents.
- After a change to the table, `nearest` and `similarity` throw `UnknownDocumentError` until the caller upserts the documents again.
