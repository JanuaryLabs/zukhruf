# SQL Server gets vectors as JSON text with nine digits

Status: proposed, for Ezz's review (2026-11-18).

SQL Server has a native `VECTOR` type on the wire, but the Node driver does not speak it yet:

- Microsoft's [driver feature matrix](https://learn.microsoft.com/sql/connect/driver-feature-matrix) gives "No" for Tedious and the `VECTOR` type. Tedious pull request [#1841](https://github.com/tediousjs/tedious/pull/1841) (opened 2026-11-17) and node-mssql issue [#1813](https://github.com/tediousjs/node-mssql/issues/1813) are open.
- For such a client, "SQL Server continues to expose vector data as varchar(max)", and the server converts a JSON array to and from a vector ([vector data type](https://learn.microsoft.com/sql/t-sql/data-types/vector-data-type)).

Probes on Azure SQL Database on 2026-11-18:

- JSON with 9 significant digits for each value (`Number(x.toPrecision(9))`) wrote the same float32 values as the full JavaScript numbers: the largest euclidean gap over 250 vectors was 0. It was 1.18 MB for 250 vectors of 384 dimensions, against 1.90 MB.
- The server gives a vector back with 8 significant digits: 7 of 1,536 values changed, by at most 1 unit in the last place (a relative error of 7.03e-8).
- A `VARCHAR` and an `NVARCHAR` parameter took 1.9 s and 2.1 s for one batch of 250 vectors.

## Decision

- The engine writes each vector as JSON text with 9 significant digits, and casts it in SQL: `CAST(@vector AS VECTOR(n))`.
- A search casts the query vector in the same way, and gives only the distance from the server.
- `get(keys, { includeVectors: true })` parses the text that the server gives. The README says that such a vector can differ from the written one by one unit in the last place.
- When Tedious supports the native type, the engine moves to it. The interface does not change.

## Consequences

- No float32 value is lost on a write, and a search computes every distance on the server.
- A batch of vectors costs more bytes than a binary format would, until the native type comes.
