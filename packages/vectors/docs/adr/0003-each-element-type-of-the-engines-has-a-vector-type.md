# Each element type of the engines has a vector type

Status: accepted by Ezz on 2026-11-18 ("Accept (Recommended)").

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
- `UnitVector` is a `Vector` of length 1, made only by `UnitVector.normalize`. A vector of length 0 or not finite is a `ZeroVectorError`. elt's copy fails the row of such a vector instead (backlog #4044, done).
- A function of the package takes only the types that the engines take for it: `fromSql` of `/sqlserver` takes no `BitVector`.

## Amendment: a zero vector (2026-11-19, backlog #4694)

Ezz ruled that the programs converge to this package where it follows the leaders. The leaders normalize so, read from their source on 2026-11-19:

| Tool                       | A zero vector                              | The precision                                             |
| -------------------------- | ------------------------------------------ | --------------------------------------------------------- |
| pgvector `l2_normalize`    | "Return zero vector for zero norm"         | float32 values, a norm summed in double, a float32 result |
| FAISS `fvec_renorm_L2`     | left as it is (`if (nr > 0)`)              | float32                                                   |
| scikit-learn `normalize`   | stays zero (`_handle_zeros_in_scale`)      | the type of the input                                     |
| PyTorch `F.normalize`      | zeros (the norm is clamped at `eps` 1e-12) | the type of the input                                     |
| sqlite-vec `vec_normalize` | NaN (it divides by 0)                      | float32                                                   |

- The precision stays: `UnitVector.normalize` divides the float32 values by a float64 norm, as pgvector does. A program that divided float64 numbers first, such as `@zukhruf/embeddings` and `@eltjs/embedding`, converges to this order; its stored vectors change by at most one unit in the last place.
- The leaders return a plain vector, so a zero vector can stay zero. A `UnitVector` promises a length of 1, so `normalize` still refuses a zero vector. `ZeroVectorError` extends `RangeError`, as the other value errors of the package do (`Vector.from`, `Int8Vector.from`), so a program that catches `RangeError` for an invalid value catches it too.

## Consequences

- The type says the element type, so `sqlType(vector)` gives `VECTOR(384, float16)` for a `HalfVector`.
- A host with a `number[]` from the AI SDK makes a vector with `Vector.from`.
