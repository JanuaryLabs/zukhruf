# Code copied from @deepagents/retrieval

`@deepagents/retrieval` (in the deepagents repository, `packages/retrieval`) keeps embeddings in SQLite already. This package keeps its own copy of that knowledge, and does not share it yet.

The reason is the Rule of Three. A second place copies the code. A third place starts the extraction, and the three working copies then give the boundary of the shared code. When a third consumer of a document embedding store needs this code, the shared parts move into one package (backlog #3134). Until then, make each fix in both copies, and name both files in the commit. This note is the input for that step.

Paths on the left are in `deepagents/packages/retrieval/src/lib`. Paths on the right are in `packages/embeddings/src`.

## Copied with changes

**`stores/cid.ts` (`cid`) → `collection.ts` (`Collection.#hash`).**
Both give the sha256 of the text, as hex. This copy hashes the JSON array `[provider, modelId, text]`, not the text alone.
Why: the vector depends on the model too. A model change must embed the text again ([ADR 0002](./adr/0002-the-hash-includes-the-model.md)).

**`stores/sqlite/sqlite.ts` (`SQLiteStore.upsertDoc` and `index`) → `collection.ts` (`Collection.upsert`).**
Both compare the stored hash with the new hash, and embed only when it differs. deepagents compares in the `WHERE` of its `ON CONFLICT` update, and reads the changed row count. This copy reads the stored hash before it calls the model, so it calls `embedMany` one time for all changed documents.
Why: one model call for a batch is faster than one call for each document.
Other changes:

- One vector for each document, not one vector for each chunk. There is no chunker. The caller chooses the text. One vector for each chunk (MaxP) waits for a consumer that needs it.
- No sources, no expiry and no metadata. A document has an id, a text and a publish date.
- The model is an AI SDK `EmbeddingModel`. deepagents uses its own `Embedder` function type (`stores/store.ts`), which gives embeddings and their dimension.
- A publish date in each row, with an index.

**`stores/sqlite/sqlite.ts` (`vectorToBlob`) → `vector.ts` (`UnitVector.normalize` and `toBlob`).**
Both store float32 values as a BLOB. deepagents copies the vector into a new `Float32Array`, and sqlite-vec normalizes it in SQL (`vec_normalize`). This copy normalizes in JavaScript, and stores the unit vector.
Why: there is no sqlite-vec here.

**`stores/sqlite/sqlite.ts` (`search`) and `stores/sqlite/ddl.sqlite.ts` (`vec_chunks`) → `collection.ts` (`Collection.nearest`) and `schema.ts`.**
deepagents searches a `vec0` virtual table of sqlite-vec with a query text, and gives the distance. This copy has a plain table, finds the neighbours of a stored document by its id, reads only the documents in the publish-date window, and gives the similarity. Equal similarities sort by id.
Why: an exact search in a small window needs no extension ([ADR 0001](./adr/0001-search-compares-each-document-in-the-window.md)). The first consumer compares stored documents with each other, not with a query.
Other changes:

- The table is `rows: 'replace'`, as `vec_chunks` is. deepagents also deletes its sources when it replaces `vec_chunks`, so its hash check embeds again. This copy keeps the hash in the same row as the vector, so a replaced table has no hash.
- The collection refuses a vector whose dimension differs from the stored vectors ([ADR 0003](./adr/0003-all-vectors-of-a-collection-have-one-dimension.md)). deepagents makes `vec_chunks` again for a new dimension.

## Not copied

- The pragmas of `SETUP` (WAL, page size, cache size). The caller opens the database, so the caller sets them.
- The connectors, the embedders and the ingest pipeline. They are not part of a store.
