# @zukhruf/sqlite-transaction

`node:sqlite` has no function that runs work in a transaction. Thus each store writes `BEGIN`, `COMMIT` and `ROLLBACK` itself. After some errors, SQLite ends the transaction itself. Then a `ROLLBACK` fails with `cannot rollback - no transaction is active`, and that error replaces the original error. This package gives one function that runs work in a transaction, and that keeps the original error. This function is also known as a transaction function or a transaction wrapper.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment. It uses only `node:sqlite`.

```sh
npm install @zukhruf/sqlite-transaction
```

```ts
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { transaction } from '@zukhruf/sqlite-transaction';

await using scratch = await mkdtempDisposable(join(tmpdir(), 'transaction-'));
using database = new DatabaseSync(join(scratch.path, 'app.sqlite'));
database.exec('CREATE TABLE notes (body TEXT) STRICT');

const rows = transaction(
  database,
  () => {
    database.exec("INSERT INTO notes VALUES ('kept')");
    try {
      transaction(
        database,
        () => {
          database.exec("INSERT INTO notes VALUES ('undone')");
          throw new Error('stop');
        },
        { mode: 'immediate' },
      );
    } catch (error) {
      console.log((error as Error).message);
    }
    return database.prepare('SELECT body FROM notes').all().length;
  },
  { mode: 'immediate' },
);
console.log(rows);
```

Output:

```
stop
1
```

## The rules

- `transaction(database, work, { mode })` runs `work`. When `work` returns, the transaction commits, and `transaction` gives the value of `work`. When `work` throws, the transaction rolls back, and `transaction` throws the same error.
- When the connection has no transaction, the call is the owner. It starts the transaction with `BEGIN DEFERRED`, `BEGIN IMMEDIATE` or `BEGIN EXCLUSIVE`, as `mode` tells.
- When the connection has a transaction, the call works in a savepoint. When `work` throws, only the changes of `work` are undone, and the outer transaction continues. The mode does not apply.
- The rollback runs only while SQLite holds the transaction. When SQLite ended the transaction itself, `transaction` throws the original error. [ADR 0001](./docs/adr/0001-roll-back-only-while-sqlite-holds-the-transaction.md) tells why.
- `work` must be synchronous. `node:sqlite` is synchronous, and a transaction cannot stay open across an `await`.
- `transaction` does not wait for a lock, and it does not try again. The busy timeout of the connection sets how long SQLite waits.

## Errors

| Error                | When                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `TypeError`          | `work` gives a promise. The transaction rolls back. TypeScript also refuses an `async` function.                      |
| The original error   | `work` throws. The transaction rolls back, or SQLite ended it before.                                                 |
| `database is locked` | `BEGIN IMMEDIATE` or `BEGIN EXCLUSIVE` waits for the busy timeout of the connection, then fails. `work` does not run. |

## The same concepts in other systems

| System                    | What it does                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| better-sqlite3            | `db.transaction(fn)` gives a function that runs `fn` in a transaction. A call inside a transaction uses a savepoint. `.deferred`, `.immediate` and `.exclusive` set the mode. It refuses a function that gives a promise. |
| Python `sqlite3`          | `with conn:` commits when the block ends, and rolls back when the block raises an exception.                                                                                                                              |
| SQLite automatic rollback | After some errors, for example `SQLITE_IOERR` or `RAISE(ROLLBACK)` in a trigger, SQLite rolls back the transaction itself. See "Response To Errors Within A Transaction" in the SQLite documentation.                     |

## Documentation

- [0001 Roll back only while SQLite holds the transaction](./docs/adr/0001-roll-back-only-while-sqlite-holds-the-transaction.md)

## Development

This package is part of the [zukhruf](../../../README.md) workspace. Run the commands from the workspace root.

```sh
npm install
npx nx run sqlite-transaction:test        # builds, then runs the tests in src/
npx nx run sqlite-transaction:typecheck   # formats, lints, then type checks
npx nx run sqlite-transaction:build       # compiles src/ to dist/
```

```
src/
  index.ts               the exports
  transaction.ts         transaction and TransactionMode
  transaction.test.ts    the tests, on real SQLite files
```
