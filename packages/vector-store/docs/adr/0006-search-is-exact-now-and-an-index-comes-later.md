# Search is exact now, and an index comes later

Status: proposed, for Ezz's review (2026-11-18).

An exact search compares the vector with each record that the filter keeps. An approximate search walks an index and can miss a near record.

Probes on Azure SQL Database (BillingDev, General Purpose Gen5 2 vCores) on 2026-11-18, with throwaway tables of 3,000 vectors of 384 dimensions:

- A DiskANN index (`CREATE VECTOR INDEX … WITH (METRIC = 'cosine', TYPE = 'DiskANN')`) was version 3. The old `TOP_N` parameter failed with Msg 42274.
- The recall@10 against the exact search was 78/80, 80/80 and 80/80 for sources of 2,000, 900 and 100 records, and 59/60 for a graph built from inserts.
- `INSERT`, `UPDATE`, `DELETE`, `MERGE` and a cascade from a foreign key showed in the next search. `TRUNCATE` worked, against the Learn page.
- An index made on an empty table started in the state `KNN` (exact), and a background task built the graph about 16 seconds after 3,000 inserts.
- At 3,000 records, an exact search took 204 ms and an approximate search 215 ms, network included.

SQL Server 2025 RTM in a container (17.0.4050) has no `VECTOR_SEARCH` and no DiskANN index ([MemberJunction's README](https://www.npmjs.com/package/@memberjunction/ai-vectors-sqlserver), checked on a live server), so a test cannot run an approximate search there. pgvector indexes vectors of up to 2,000 dimensions. sqlite-vec's `vec0` searches exactly.

## Decision

- Each engine searches exactly in the first release.
- An index is "later", as one option of the definition (`index: 'diskann'` on SQL Server, `'hnsw'` on Postgres), when a consumer's search is slow.
- The SQL Server table has a `BIGINT IDENTITY` clustered key and a unique key column now, which is the shape that a vector index needs, so a later index needs no new table.

## Consequences

- Each engine gives the true nearest records, so the tests compare the engines with each other.
- A search of a large collection reads each record that the filter keeps; the filter is the tool to keep it small until an index comes.
