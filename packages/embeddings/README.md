# @zukhruf/embeddings

A program that compares texts by meaning needs a vector for each text, and the model call that makes the vector is slow. This package keeps the vectors of documents in a SQLite database. An upsert calls the model only for new or changed text. A search gives the nearest documents of a document, by exact cosine similarity, from the documents published near it. This kind of package is also known as a vector store.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment. It uses `node:sqlite` and an embedding model of the [AI SDK](https://ai-sdk.dev). The package does not start a model or a server. Give it a model that is ready.

```sh
npm install @zukhruf/embeddings ai
```

```ts
import { DatabaseSync } from 'node:sqlite';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { Collection } from '@zukhruf/embeddings';

const local = createOpenAICompatible({
  name: 'llama.cpp',
  baseURL: 'http://127.0.0.1:8080/v1',
});
using database = new DatabaseSync('embeddings.sqlite');
const collection = new Collection({
  database,
  model: local.embeddingModel('embeddinggemma'),
});

await collection.upsert([
  {
    id: 'a',
    text: 'Storm closes the port',
    publishedAt: new Date('2026-10-20'),
  },
  {
    id: 'b',
    text: 'Port shut as storm hits',
    publishedAt: new Date('2026-10-21'),
  },
  { id: 'c', text: 'Port opens again', publishedAt: new Date('2026-11-30') },
]);

collection.nearest('a', { k: 10, withinDays: 7 }); // [{ id: 'b', similarity: … }]
collection.similarity('a', 'c');
```

## API

- `new Collection({ database, model })`. The caller opens and closes `database`. The collection makes its table `embedding_document` in it. `model` is an AI SDK embedding model object.
- `upsert(documents)` stores each document. It calls the model, through `embedMany`, only for a document whose text or model changed. It stores the new publish date of each document.
- `nearest(id, { k, withinDays })` gives at most `k` neighbours of the document, with the highest similarity first. A neighbour has a publish date at most `withinDays` days before or after the publish date of the document. Equal similarities sort by id.
- `neighbourGraph({ from, to, k, withinDays })` gives an iterator of `[id, neighbours]` entries, one for each document published from `from` to `to`, in the order of the publish dates and then of the ids. The neighbours of each entry are equal to the result of `nearest(id, { k, withinDays })`. A document outside the range has no entry, but it can be a neighbour of a document in the range. The call reads and decodes each vector one time ([ADR 0004](./docs/adr/0004-a-neighbour-graph-decodes-each-vector-once.md)). Use it when you need the neighbours of many documents.
- `similarity(a, b)` gives the cosine similarity of two stored documents.

## Errors

- `UnknownDocumentError`: `nearest` or `similarity` got an id that the collection does not store.
- `DimensionMismatchError`: the model gave a vector with a dimension that is not the dimension of the stored vectors. The upsert stores none of its documents. To change to a model with another dimension, upsert all documents in one call.

## Limits

- One database holds one collection.
- The collection stores the vector of the text, not the text. The caller chooses the text, for example a title and the first sentences.
- A document has one vector. A long text gives one mean vector, and its details become a small part of it.
- The search reads each document in the window ([ADR 0001](./docs/adr/0001-search-compares-each-document-in-the-window.md)). A window of many thousand documents is slow. A neighbour graph decodes each vector once, but it still calculates a similarity for each pair of documents in a window.
- After a model change, upsert all documents again ([ADR 0002](./docs/adr/0002-the-hash-includes-the-model.md)).

## Decisions

- [ADR 0001: A search compares each document in the window, with no index](./docs/adr/0001-search-compares-each-document-in-the-window.md)
- [ADR 0002: The hash includes the model](./docs/adr/0002-the-hash-includes-the-model.md)
- [ADR 0003: All vectors of a collection have one dimension](./docs/adr/0003-all-vectors-of-a-collection-have-one-dimension.md)
- [ADR 0004: A neighbour graph decodes each vector once](./docs/adr/0004-a-neighbour-graph-decodes-each-vector-once.md)
- [Code copied from @deepagents/retrieval](./docs/copied-from-deepagents-retrieval.md)
