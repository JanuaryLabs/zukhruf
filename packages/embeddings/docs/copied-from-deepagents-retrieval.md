# Code copied from @deepagents/retrieval

`@deepagents/retrieval` (in the deepagents repository, `packages/retrieval`) kept embeddings in SQLite before this package did. This package copied that knowledge.

The source is deleted. On 2026-11-24, deepagents commit 9564ec80 (#5406, released as 7.30.1) deleted `@deepagents/retrieval`. The last version on npm is 7.30.0. Thus this copy has no source left, and no fix has a second copy to mirror. The Rule of Three counts one place now. Nothing moves to a shared package because of this ledger.

The notes below record where the code came from, and how it changed.

Paths on the left were in `deepagents/packages/retrieval/src/lib`, at the commit before 9564ec80. Paths on the right are in `packages/embeddings/src`.

## Copied with changes

**`stores/sqlite/sqlite.ts` (`SQLiteStore.upsertDoc` and `index`) → `collection.ts` (`Collection.upsert`).**
deepagents compared the stored hash (`stores/cid.ts`, `cid`) with the new hash in the `WHERE` of its `ON CONFLICT` update. This copy keeps no hash: it embeds every text through a model wrapped with `@zukhruf/embedding-cache`, which calls the model only for the texts it did not embed before, in one `embedMany` call ([ADR 0002](./adr/0002-the-hash-includes-the-model.md), amendment of 2026-11-19).
Other changes:

- One vector for each document, not one vector for each chunk. There is no chunker. The caller chooses the text. One vector for each chunk (MaxP) waits for a consumer that needs it.
- No sources, no expiry and no metadata. A document has an id, a text and a publish date.
- The model is an AI SDK `EmbeddingModel`. deepagents used its own `Embedder` function type (`stores/store.ts`), which gave embeddings and their dimension.
- A publish date in each row, with an index.

**`stores/sqlite/sqlite.ts` (`vectorToBlob`) → `UnitVector.normalize` of `@zukhruf/vectors`, then `toSql` of `@zukhruf/vectors/sqlite`.**
Both store float32 values as a BLOB. deepagents copied the vector into a new `Float32Array`, and sqlite-vec normalized it in SQL (`vec_normalize`). This package normalizes in JavaScript and stores the unit vector. The BLOB form (`toSql`, `fromSql`, float32 little-endian), the dot product (`dot`, backlog #4683), the unit vector (`UnitVector.normalize`) and `DimensionMismatchError` (backlog #4694) come from `@zukhruf/vectors`, so they are no longer copies here.
Why: there is no sqlite-vec here.

**`stores/sqlite/sqlite.ts` (`search`) and `stores/sqlite/ddl.sqlite.ts` (`vec_chunks`) → `collection.ts` (`Collection.nearest`) and `schema.ts`.**
deepagents searched a `vec0` virtual table of sqlite-vec with a query text, and gave the distance. This copy has a plain table, finds the neighbours of a stored document by its id, reads only the documents in the publish-date window, and gives the similarity. Equal similarities sort by id.
Why: an exact search in a small window needs no extension ([ADR 0001](./adr/0001-search-compares-each-document-in-the-window.md)). The first consumer compares stored documents with each other, not with a query.
Other changes:

- The table is `rows: 'replace'`, as `vec_chunks` was. deepagents also deleted its sources when it replaced `vec_chunks`, so its hash check embedded again. Here the cache keeps its own table, so a replaced table is filled again from the cache.
- The collection refuses a vector whose dimension differs from the stored vectors ([ADR 0003](./adr/0003-all-vectors-of-a-collection-have-one-dimension.md)). deepagents made `vec_chunks` again for a new dimension.

## Not copied

- The pragmas of `SETUP` (WAL, page size, cache size). The caller opens the database, so the caller sets them.
- The connectors, the embedders and the ingest pipeline. They are not part of a store.
