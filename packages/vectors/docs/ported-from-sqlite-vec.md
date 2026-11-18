# Ported from sqlite-vec

`install` of `@zukhruf/vectors/sqlite` registers two SQL functions of [sqlite-vec](https://github.com/asg017/sqlite-vec) 0.1.9 on a database that does not load the extension ([ADR 0005](./adr/0005-plain-sqlite-gets-the-distance-functions-of-sqlite-vec.md)). `src/sqlite.test.ts` runs each case below against the port and against the real extension, and compares the two.

## The same as sqlite-vec

| Behavior                     | sqlite-vec 0.1.9 and the port                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Names                        | `vec_distance_cosine`, `vec_distance_L2`                                                                                        |
| Input                        | a BLOB of float32 values, little-endian, or the text of a JSON array                                                            |
| Cosine                       | 1 − the cosine similarity; `NULL` when one vector has length 0                                                                  |
| L2                           | the euclidean distance; a number for a zero vector                                                                              |
| A BLOB of another length     | `Error reading 1st vector: invalid float32 vector BLOB length. Must be divisible by 4, found 3` (`2nd` for the second argument) |
| An empty BLOB or `[]`        | `Error reading 1st vector: zero-length vectors are not supported.`                                                              |
| `NULL`, an integer or a real | `Error reading 1st vector: Input must have type BLOB (compact format) or TEXT (JSON), found NULL` (`INTEGER`, `FLOAT`)          |
| Other dimensions             | `Vector dimension mistmatch. First vector has 2 dimensions, while the second has 3 dimensions.` (the spelling is sqlite-vec's)  |
| Determinism                  | deterministic, so an index expression can use them                                                                              |

## Where the port differs

| Behavior                | sqlite-vec 0.1.9                                       | The port                                                             | Why                                                                                                                                       |
| ----------------------- | ------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| The value of a distance | float32 arithmetic, with SIMD on some CPUs             | float64 arithmetic on the float32 values                             | The order of the additions in SIMD differs by CPU, so only float32 precision is the same everywhere. The test compares to a relative 1e-6 |
| Malformed JSON          | reads some of it: `'[1,'` as `[1]`                     | `Error reading 1st vector: the text is not a JSON array of numbers.` | Reading part of a malformed vector gives a wrong distance with no error                                                                   |
| int8 and bit vectors    | `vec_int8(?)`, `vec_bit(?)` and `vec_distance_hamming` | not ported                                                           | A function of `node:sqlite` cannot read the subtype that `vec_int8` and `vec_bit` set. Hamming waits (README, Later)                      |
