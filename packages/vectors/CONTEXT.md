# Vectors

A vector is a list of numbers that a model makes from a text. This package gives the vector types, their math, and the form of each vector in each database. The words below have one meaning each in its documents.

## Language

**Vector**:
A list of float32 numbers with a fixed number of dimensions. `Vector` is the type.
_Avoid_: Embedding (for the type), array, tensor

**Element type**:
The type of each number of a vector: float32, float16, int8 or bit. Each element type has its own vector type.
_Avoid_: Base type, precision, dtype

**Half vector**:
A vector of float16 numbers. SQL Server keeps it as `VECTOR(n, float16)`.
_Avoid_: Float16 vector, halfvec

**Bit vector**:
A vector of bits, packed eight to a byte. sqlite-vec packs the least significant bit first.
_Avoid_: Binary vector

**Dimensions**:
The number of elements of a vector. Two vectors of one call have the same dimensions.
_Avoid_: Size, length (length is the norm)

**Unit vector**:
A vector divided by its length, so its length is 1. The cosine similarity of two unit vectors is their dot product.
_Avoid_: Normalized vector

**Distance**:
How far one vector is from another. A lower distance is nearer. Cosine distance is 1 − the cosine similarity, from 0 to 2.
_Avoid_: Score, metric

**Engine**:
A database and the way it keeps vectors: plain SQLite, SQLite with sqlite-vec, or SQL Server. Each engine has one subpath of the package; plain SQLite and sqlite-vec share `/sqlite`.
_Avoid_: Backend, adapter, store, driver

**SQL form**:
The value of a vector that an engine reads and writes: bytes for SQLite, JSON text for SQL Server. `toSql` makes it and `fromSql` reads it.
_Avoid_: Serialization, encoding, wire format

**Host**:
The program that writes the SQL, runs it with its own driver, and puts the values of this package into it.
_Avoid_: Consumer, client, caller (for the program as a whole)
