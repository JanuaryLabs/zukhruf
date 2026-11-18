# Plain SQLite gets the distance functions of sqlite-vec

Status: proposed, for Ezz's review (2026-11-18).

A program on plain SQLite cannot compare vectors in SQL, so `@zukhruf/embeddings` reads the rows and compares them in JavaScript (its ADR 0001). `node:sqlite` has `database.function(name, options, fn)`. On 2026-11-18 a function registered so sorted the rows of a table in `ORDER BY`, after a `WHERE … OR …` of the host, with `LIMIT`.

sqlite-vec 0.1.9 gives the same distances as SQL functions. Probed:

- `vec_distance_cosine` and `vec_distance_L2` read raw float32 BLOBs.
- A zero vector gives `NULL`.
- Two vectors of other dimensions fail with "Vector dimension mistmatch. First vector has 2 dimensions, while the second has 3 dimensions." (the spelling is sqlite-vec's).
- `vec_distance_hamming` needs `vec_bit(?)`; a raw BLOB is read as float32.

## Decision

- `install(database)` registers `vec_distance_cosine` and `vec_distance_L2` on a `DatabaseSync`, as deterministic functions, with the names, the results, the `NULL` and the error texts of sqlite-vec 0.1.9. This is a port of those two functions.
- The SQL of a host then runs on plain SQLite and on sqlite-vec without a change.
- `install` on a database that loaded sqlite-vec is a `SqliteVecLoadedError`: two functions with one name would leave it unclear which one runs. The check calls `vec_version()` and expects the error of a missing function.
- Hamming waits: a plain SQLite function cannot read the subtype that `vec_bit` sets.

## Consequences

- `@zukhruf/embeddings` can sort and filter in SQL instead of in JavaScript.
- A test runs the same queries against plain SQLite with `install` and against sqlite-vec, and compares the results.
