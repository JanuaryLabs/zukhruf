# SQL Server gets JSON text with the digits that keep each value

Status: proposed, for Ezz's review (2026-11-18).

SQL Server has a native `VECTOR` type on the wire, but the Node driver does not speak it yet:

- Microsoft's [driver feature matrix](https://learn.microsoft.com/sql/connect/driver-feature-matrix) gives "No" for Tedious and the `VECTOR` type. Tedious pull request [#1841](https://github.com/tediousjs/tedious/pull/1841) (opened 2026-11-17) and node-mssql issue [#1813](https://github.com/tediousjs/node-mssql/issues/1813) are open.
- For such a client, "SQL Server continues to expose vector data as varchar(max)", and the server converts a JSON array to and from a vector ([vector data type](https://learn.microsoft.com/sql/t-sql/data-types/vector-data-type)).

Probes on Azure SQL Database on 2026-11-18:

| Element type | Digits written | Values changed after a write and a read                                                                                                                             |
| ------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| float32      | 9              | none on the write (largest euclidean gap 0 over 250 vectors); on the read, the server prints 8 digits: 7 of 1,536 values differ by at most 1 unit in the last place |
| float16      | 4              | 2 of 384                                                                                                                                                            |
| float16      | 5              | 0 of 384                                                                                                                                                            |

Nine digits made the JSON of 250 vectors of 384 dimensions 1.18 MB, against 1.90 MB for the full JavaScript numbers. A `VARCHAR` and an `NVARCHAR` parameter took 1.9 s and 2.1 s for one such batch.

## Decision

- `toSql` writes each value with 9 significant digits for a `Vector` and 5 for a `HalfVector`, the fewest that keep each value.
- The host casts the text in its SQL: `CAST(@q AS ${sqlType(vector)})`.
- `fromSql(Vector, text)` can differ from the written vector by one unit in the last place; the README says so. `fromSql(HalfVector, text)` gives the written values.
- When tedious supports the native type, the subpath gives that form too. The JSON form stays for other drivers.

## Consequences

- No value is lost on a write. A host that computes distances in SQL never reads a vector back.
