# Each element type of the engines has a vector type

Status: proposed, for Ezz's review (2026-11-18).

The engines of the first release store four element types:

| Element type | SQLite (plain) | sqlite-vec                                                                                         | SQL Server                                             |
| ------------ | -------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| float32      | a BLOB         | `FLOAT[n]`, `vec_f32`                                                                              | `VECTOR(n)`                                            |
| float16      | no             | no                                                                                                 | `VECTOR(n, float16)` (probed on Azure SQL, 2026-11-18) |
| int8         | a BLOB         | `INT8[n]`, `vec_int8`                                                                              | no                                                     |
| bit          | a BLOB         | `BIT[n]`, `vec_bit`, least significant bit first (probed: `vec_bit(X'01')` is `[1,0,0,0,0,0,0,0]`) | no                                                     |

The pgvector clients have one type for each element type (`Vector`, `HalfVector`, `SparseVector`). A plain `Float32Array` cannot say that a vector is float16, so a SQL form could not choose `VECTOR(n, float16)`.

## Decision

- `Vector` holds a `Float32Array`, `HalfVector` a `Float16Array` (Node v26.13.0 has `Float16Array` and `Math.f16round`), `Int8Vector` an `Int8Array`, and `BitVector` its packed bits.
- Each type has `from(values)`, which copies the values, and `dimensions`. A value that is not finite, or an int8 value out of range, is a `RangeError`.
- `UnitVector` is a `Vector` of length 1, made only by `UnitVector.normalize`. A vector of length 0 or not finite is a `ZeroVectorError` (backlog #4044: elt's copy has no such check).
- A function of the package takes only the types that the engines take for it: `fromSql` of `/sqlserver` takes no `BitVector`.

## Consequences

- The type says the element type, so `sqlType(vector)` gives `VECTOR(384, float16)` for a `HalfVector`.
- A host with a `number[]` from the AI SDK makes a vector with `Vector.from`.
