# Recipe: Keep a vector in a SQLite BLOB column and read it back

**Use case.** A program keeps the vector of each text in a `BLOB` column of SQLite, and reads it back later: to compare it in memory, or to give it to another engine. SQLite has no vector type, so the program needs the bytes of the vector. Without the package, each program writes its own `DataView` loop for float32 values, little-endian, and its own loop to read them back. elt did this for its part hash until commit `04cc6060` of elt, which replaced the loop with `toSql` and kept the same bytes.

**What you need.** `node:sqlite`, a `Vector`, and `toSql` and `fromSql` of `@zukhruf/vectors/sqlite`.

## The steps

1. Give the column the SQLite type `BLOB`.
2. Write `toSql(vector)` as the value of the column.
3. Read the column. `node:sqlite` gives a `BLOB` as a `Uint8Array`.
4. Give the bytes to `fromSql(Vector, bytes)`. The bytes do not say their element type, so `fromSql` takes the vector type ([ADR 0006](../adr/0006-each-engine-has-tosql-and-fromsql-after-pgvector.md)).

## The program

The program keeps one unit vector in a table in memory, reads it back, and compares the values. Then it gives `fromSql` a `BLOB` of 6 bytes.

```ts title="keep-a-vector.ts"
import { DatabaseSync } from 'node:sqlite';

import { UnitVector, Vector } from '@zukhruf/vectors';
import { fromSql, toSql } from '@zukhruf/vectors/sqlite';

using database = new DatabaseSync(':memory:');
database.exec(`CREATE TABLE chunks (id TEXT PRIMARY KEY, embedding BLOB)`);

// Write: toSql gives the bytes, 4 for each dimension.
const written = UnitVector.normalize(Vector.from([3, 4, 0]));
const bytes = toSql(written);
database
  .prepare(`INSERT INTO chunks (id, embedding) VALUES (?, ?)`)
  .run('guide#0', bytes);
console.log(`wrote ${written.dimensions} dimensions as ${bytes.length} bytes`);

// Read: node:sqlite gives a BLOB as a Uint8Array, and fromSql reads it.
const row = database
  .prepare(`SELECT embedding FROM chunks WHERE id = ?`)
  .get('guide#0');
if (!(row?.['embedding'] instanceof Uint8Array)) {
  throw new TypeError('The embedding column has no BLOB');
}
const read = fromSql(Vector, row['embedding']);
console.log('read values:', [...read.values]);
console.log(
  'same values:',
  read.values.every((value, index) => value === written.values[index]),
);
console.log('read is a UnitVector:', read instanceof UnitVector);

// A BLOB whose length does not fit the type is a RangeError.
try {
  fromSql(Vector, new Uint8Array(6));
} catch (error) {
  if (!(error instanceof RangeError)) throw error;
  console.log(`${error.name}: ${error.message}`);
}
```

Output:

```
wrote 3 dimensions as 12 bytes
read values: [ 0.6000000238418579, 0.800000011920929, 0 ]
same values: true
read is a UnitVector: false
RangeError: A float32 vector BLOB has a multiple of 4 bytes, not 6
```

## What the output shows

- `toSql` wrote 4 bytes for each dimension: the float32 values, little-endian ([src/sqlite.ts](../../src/sqlite.ts)).
- `fromSql` read the same float32 values back. 0.6 and 0.8 show as `0.6000000238418579` and `0.800000011920929`, because a `Vector` keeps float32 values. The test "fromSql reads back what toSql wrote" in [src/sqlite.test.ts](../../src/sqlite.test.ts) proves the same for a `Vector`, an `Int8Vector` and a `BitVector`.
- The vector that `fromSql` read is a `Vector`, not a `UnitVector`, also when the program wrote a unit vector. The bytes do not say that the length is 1.
- A `BLOB` of 6 bytes does not fit float32 values, so `fromSql` refused it with a `RangeError` (test "fromSql refuses a BLOB whose length does not fit its type").

## Things to know

- **sqlite-vec reads the same bytes.** A `vec0` table and `vec_distance_cosine` take the bytes of `toSql` as they are, and `install` gives plain SQLite the same distance functions. See [Search in plain SQLite](../../README.md#search-in-plain-sqlite).
- **Give `fromSql` the type that wrote the bytes.** An `Int8Vector` has 1 byte for each dimension, and a `BitVector` packs 8 bits in each byte. `fromSql(Vector, …)` of those bytes gives other values, or a `RangeError` when the length is not a multiple of 4.
- **Programs that do this now.** [`@zukhruf/embeddings`](../../../embeddings/src/collection.ts) writes each unit vector with `toSql` and reads it with `fromSql(Vector, …)`. The SQLite destination of elt (`packages/destinations/sqlite/src/sqlite-rule-columns.ts`) writes with `toSql`.
