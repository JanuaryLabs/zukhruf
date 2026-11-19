# Recipe: Search a vector table that another program writes

**Use case.** A program keeps its vectors in its own SQLite table, and not in a collection. For example, the `Embedding` rule of elt writes one vector beside each row of a source. A `VectorSearch` searches that vector table with the same rules as a collection, so the program does not copy its vectors into a collection only to search them (commit `7e6d2a63`, [ADR 0005](../adr/0005-a-vector-search-reads-a-vector-table-of-unit-vectors.md)). The search does not examine the vectors. When the writer stores a vector that is not a unit vector, each similarity is incorrect, and no error tells you.

**What you need.** A SQLite database, the vectors, `UnitVector` and `Vector` of `@zukhruf/vectors`, and `toSql` of `@zukhruf/vectors/sqlite`. The program on this page gives the vectors by hand, so it needs no model.

## The steps

1. Make a table or a view with the columns `id` (text) and `vector` (a BLOB).
2. Add the column `published_at` (milliseconds since the Unix epoch) when you search with `nearest`, `neighbourGraph`, `similarity` or a query with a date range. A query without a date range does not read `published_at` (commit `871fa3bb`, [ADR 0007](../adr/0007-a-query-without-a-date-range-compares-every-document.md)).
3. Make each vector a unit vector with `UnitVector.normalize(Vector.from(values))`, and write it with `toSql`.
4. Catch the `ZeroVectorError` of `UnitVector.normalize`, and do not store that row. A vector of length 0 has no unit vector.
5. Give the name of the table or the view to `new VectorSearch({ database, table })`.

## The program

The program writes two vector tables. The table `passage_vectors` has no `published_at`, so the program searches it with a query without a date range. The table `news` has other column names and a publish date as text. The view `news_vectors` gives its columns the names `id`, `vector` and `published_at`, and the program searches the view.

```ts title="search-own-table.ts"
import { DatabaseSync } from 'node:sqlite';

import { VectorSearch } from '@zukhruf/embeddings';
import { UnitVector, Vector, ZeroVectorError } from '@zukhruf/vectors';
import { toSql } from '@zukhruf/vectors/sqlite';

using database = new DatabaseSync(':memory:');

// The writer makes each vector a unit vector before it stores it. A vector
// of length 0 has no unit vector, so the writer skips its row.
function unitVector(values: number[]): Uint8Array | undefined {
  try {
    return toSql(UnitVector.normalize(Vector.from(values)));
  } catch (error) {
    if (error instanceof ZeroVectorError) return undefined;
    throw error;
  }
}

// 1. A table of passages, with no publish date.
database.exec(
  'CREATE TABLE passage_vectors (id TEXT PRIMARY KEY, vector BLOB)',
);
const insertPassage = database.prepare(
  'INSERT INTO passage_vectors (id, vector) VALUES (?, ?)',
);
const passages: [string, number[]][] = [
  ['ran-a-data-team', [0.9, 0.1, 0.2]],
  ['wrote-sql-reports', [0.7, 0.6, 0.1]],
  ['taught-swimming', [0.1, 0.2, 0.9]],
  ['empty-passage', [0, 0, 0]],
];
for (const [id, values] of passages) {
  const vector = unitVector(values);
  if (vector === undefined) console.log(`skipped ${id}: length 0`);
  else insertPassage.run(id, vector);
}

const passageSearch = new VectorSearch({ database, table: 'passage_vectors' });
console.log('query, no date range:', passageSearch.query([1, 0.2, 0.1]));
try {
  passageSearch.nearest('ran-a-data-team', { k: 2, withinDays: 30 });
} catch (error) {
  console.log('nearest:', Error.isError(error) ? error.message : error);
}

// 2. A table of news with other column names, and a view that gives the
// columns id, vector and published_at.
database.exec(`
  CREATE TABLE news (slug TEXT PRIMARY KEY, embedding BLOB, published TEXT);
  CREATE VIEW news_vectors AS
    SELECT slug AS id, embedding AS vector,
      CAST(unixepoch(published) AS INTEGER) * 1000 AS published_at
    FROM news;
`);
const insertNews = database.prepare(
  'INSERT INTO news (slug, embedding, published) VALUES (?, ?, ?)',
);
const news: [string, number[], string][] = [
  ['storm-closes-port', [0.9, 0.3, 0.1], '2026-10-20'],
  ['port-shut-by-storm', [0.8, 0.4, 0.1], '2026-10-21'],
  ['port-opens-again', [0.7, 0.5, 0.2], '2026-11-30'],
  ['swim-club-wins', [0.1, 0.1, 0.9], '2026-10-22'],
];
for (const [id, values, published] of news) {
  const vector = unitVector(values);
  if (vector !== undefined) insertNews.run(id, vector, published);
}

const newsSearch = new VectorSearch({ database, table: 'news_vectors' });
console.log(
  'nearest, 7 days:',
  newsSearch.nearest('storm-closes-port', { k: 2, withinDays: 7 }),
);
console.log(
  'query, October:',
  newsSearch.query([1, 0.3, 0], {
    from: new Date('2026-10-01'),
    to: new Date('2026-10-31'),
  }),
);
```

Output (the text of the SQLite error comes from SQLite 3.54.0 in Node 26.13.0):

```
skipped empty-passage: length 0
query, no date range: [
  { id: 'ran-a-data-team', similarity: 0.9891997136458683 },
  { id: 'wrote-sql-reports', similarity: 0.8734422803027057 },
  { id: 'taught-swimming', similarity: 0.24203822763463156 }
]
nearest: no such column: "published_at" - should this be a string literal in single-quotes?
nearest, 7 days: [
  { id: 'port-shut-by-storm', similarity: 0.9900468007644192 },
  { id: 'swim-club-wins', similarity: 0.24163484325089657 }
]
query, October: [
  { id: 'storm-closes-port', similarity: 0.9940339971226271 },
  { id: 'port-shut-by-storm', similarity: 0.9791112946238796 },
  { id: 'swim-club-wins', similarity: 0.13667562179717985 }
]
```

## What the output shows

- `UnitVector.normalize` refused the vector of `empty-passage`, so the writer did not store it. A copy of the division with no check for length 0 divides by 0, and stores a vector of `NaN` values as a document (`ZeroVectorError` in `packages/vectors/src/vector.ts`).
- The query without a date range compared the query vector with each document of `passage_vectors`, a table with no `published_at`.
- `nearest` on `passage_vectors` gave the SQLite error `no such column`, because `nearest` reads the publish date of each document. `similarity` and `neighbourGraph` give the same error on that table.
- The view `news_vectors` renamed the columns, and `VectorSearch` searched it as a table. `port-opens-again` is not a neighbour of `storm-closes-port`, because its publish date is 41 days later, outside the window of 7 days.
- The query with a date range of October gave only the documents published in October.

## Things to know

- **The search does not normalize a vector that it reads.** It calculates each similarity as a dot product, which is the cosine only for unit vectors ([ADR 0005](../adr/0005-a-vector-search-reads-a-vector-table-of-unit-vectors.md)). Use `UnitVector.normalize`, and do not copy its division into your program. elt's `Embedding` rule calls `UnitVector.normalize`, and fails the row when it throws (`packages/embedding/src/embedding.ts` in elt).
- **All vectors of one vector table have one dimension.** A query vector with another dimension is the `DimensionMismatchError` of `@zukhruf/vectors` ([README](../../README.md)).
- **Each call reads the table again.** The writer can add, change and delete rows between two calls, and the next call sees them ([README](../../README.md)).
- **A table name is quoted as an SQL identifier.** A name that SQLite cannot find gives the SQLite error of the call, not an error of the package ([ADR 0005](../adr/0005-a-vector-search-reads-a-vector-table-of-unit-vectors.md)).
