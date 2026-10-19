# @zukhruf/sqlite-federation

A host keeps its data in many SQLite databases, for example one database for each data source. A statement must read some of them together, for example to join messages with contacts. One SQLite connection can attach at most 10 databases, and the SQLite in Node cannot raise that limit. This package gives one read-only handle over a primary database and every additional database that the host can locate. The primary database stays open for the lifetime of the handle. Each statement attaches the additional databases it names and detaches them when it ends. This is also known as query federation: one query reads many separate databases.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment. It uses only `node:sqlite`.

```sh
npm install @zukhruf/sqlite-federation
```

## Read many databases with one handle

The host gives `locate`. A statement names each database as a schema.

```ts
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Federation } from '@zukhruf/sqlite-federation';

await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
const messagesPath = join(scratch.path, 'messages.sqlite');
const contactsPath = join(scratch.path, 'contacts.sqlite');
{
  using messages = new DatabaseSync(messagesPath);
  messages.exec(`CREATE TABLE messages (handle TEXT, text TEXT);
    INSERT INTO messages VALUES ('+962790000000', 'See you at 6');`);
  using contacts = new DatabaseSync(contactsPath);
  contacts.exec(`CREATE TABLE contacts (phone TEXT, name TEXT);
    INSERT INTO contacts VALUES ('+962790000000', 'Sara');`);
}
const paths = new Map([
  ['messages', messagesPath],
  ['contacts', contactsPath],
]);

using federation = new Federation({
  main: ':memory:',
  locate: (name) => paths.get(name),
});
console.log(federation.sql.all`
  SELECT c.name, m.text
  FROM messages.messages m JOIN contacts.contacts c ON c.phone = m.handle`);
```

Output:

```
[ [Object: null prototype] { name: 'Sara', text: 'See you at 6' } ]
```

- `sql` has `all` and `get` of the `SQLTagStore` of `node:sqlite`. A value in `${}` is a bound parameter.
- `main` is a primary database path or `{ name }` to find that path through `locate`. It is opened read-only for the lifetime of the handle. Use `':memory:'` when there is no primary file. `main` does not count toward the attachment limit.
- A statement names each additional database as a schema: `messages.messages`. Use unqualified names for the primary database and temporary views; qualify cross-database tables. There is no pre-attached search path for unqualified source tables.
- `locate(name)` is required. It returns the path of a database, or `undefined` when the host has no database by that name. The constructor calls it once for a named `main`; each statement calls it for additional databases, so it reads them from their new paths after the host moves them.
- Return `undefined` for a database that the host has not written yet. The handle cannot make a database, so an attach of a path with no file fails.
- Additional databases are read-only. A statement that writes to one fails with `attempt to write a readonly database`. Connection-local temporary objects remain writable.
- `using` closes the connection of the handle at the end of its scope.

## Load temporary views and run SQL strings

`exec(sql)` executes connection-local setup SQL, including a file containing several `CREATE TEMP VIEW` statements. It uses SQLite's `exec` directly, without replaying the script. The databases a temporary view refers to are resolved when a query reads it.

`query(sql)` runs exactly one SQL statement and returns `QueryResult`: `columns`, including headings when there are no rows, and `rows`, whose values are indexed by column position. Duplicate column names therefore keep both values. Trailing comments and empty statements are allowed; a second statement, even malformed, fails before the first executes.

```ts
federation.exec(`
  CREATE TEMP VIEW conversations AS
  SELECT c.name, m.text
  FROM messages.messages m JOIN contacts.contacts c ON c.phone = m.handle;
`);
const result = federation.query('SELECT * FROM conversations');
```

Qualified tables and PRAGMAs discover additional databases through `locate`. Both `PRAGMA contacts.table_info(contacts)` and `SELECT * FROM pragma_table_info('contacts', 'contacts')` locate Contacts, including when the schema is a bound parameter in a tagged query. Quoted schema names such as `"call-history"` work too. Every attachment made for the statement is detached afterwards, including on failure; `main` and temporary views remain on the connection. The additional databases count toward the attachment limit.

The constructor accepts Node's `timeout` option for waiting on a writer's lock, in milliseconds. Omit it to use Node's native behavior. Hosts that need crash recovery perform it before supplying the paths, including inside `locate` for a named primary or additional database; Federation opens those files read-only.

## Read a primary database

Supply `main: { name }` to find the primary database through `locate`, or supply its path directly. Tables can be qualified with `main`, and unqualified schema queries and PRAGMAs describe that database. A named primary is opened as `main`, not attached under its name. Presets loaded with `exec` live on the same connection and can be joined with attached databases. Federation closes the connection on disposal.

```ts
import { Federation } from '@zukhruf/sqlite-federation';

using database = new Federation({
  main: { name: 'messages' },
  locate: (name) => paths.get(name),
  timeout: 30_000,
});
const result = database.query(
  'SELECT c.name, m.text FROM main.messages m JOIN contacts.contacts c ON c.phone = m.handle',
);
```

## Each statement attaches what it names

- SQLite fails with `no such table: <name>.<table>` for a qualified table or `unknown database <name>` for a PRAGMA when its database is not attached. The handle decodes the name, attaches that database and runs the statement again. It never parses the statement. [ADR 0002](./docs/adr/0002-the-error-of-sqlite-names-the-database.md) tells why.
- When the statement ends, the handle detaches each database that it attached, also when the statement fails. An attach costs less than 1 ms. [ADR 0001](./docs/adr/0001-each-statement-attaches-what-it-names.md) tells why.
- Between two statements, the handle holds no lock. A writer in another connection or process can commit.
- One statement can attach at most 10 databases in addition to `main`. To read more, split the statement and join the rows in code. [ADR 0003](./docs/adr/0003-a-statement-over-the-limit-fails.md) tells why.

## Errors

| Error                                  | When                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TooManyDatabasesError`                | A statement names more databases than the limit. `names` has at least one name more than the limit. The message tells you to split the statement. |
| `Unknown main database <name>`         | The constructor cannot locate the named primary database.                                                                                         |
| `no such table: <name>.<table>`        | The error of SQLite, when `locate` returns `undefined` for the name, or when the database does not have the table.                                |
| `unable to open database file`         | The error of SQLite, when `locate` returns a path with no file.                                                                                   |
| `attempt to write a readonly database` | The error of SQLite, when a statement writes.                                                                                                     |
| The error of `locate`                  | The constructor or statement fails with that error. The databases that the statement attached before are detached.                                |
| `unknown database <name>`              | The error of SQLite, when a PRAGMA names a database that `locate` cannot find. Quoting follows the statement or the table-valued PRAGMA argument. |
| `Run one SQL statement at a time`      | A raw query contains a second statement.                                                                                                          |

## The same concepts in other systems

| System                    | What it does                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite `swarmvtab`        | A virtual table over one table in many databases. It opens each database on its own connection and closes the least recently used one. It is an extension that Node does not include. |
| Datasette `--crossdb`     | It attaches the first 10 databases and ignores the others.                                                                                                                            |
| `q` (harelba/q)           | It attaches databases up to the limit, and copies the tables of the others into a temporary database.                                                                                 |
| PostgreSQL `postgres_fdw` | A foreign table reads a table of another server, and one query can join it with local tables.                                                                                         |

## Documentation

- [0001 Each statement attaches what it names](./docs/adr/0001-each-statement-attaches-what-it-names.md)
- [0002 The error of SQLite names the database](./docs/adr/0002-the-error-of-sqlite-names-the-database.md)
- [0003 A statement over the limit fails](./docs/adr/0003-a-statement-over-the-limit-fails.md)

## Development

This package is part of the [zukhruf](../../../README.md) workspace. Run the commands from the workspace root.

```sh
npm install
npx nx run sqlite-federation:test        # builds, then runs the tests in src/
npx nx run sqlite-federation:typecheck   # formats, lints, then type checks
npx nx run sqlite-federation:build       # compiles src/ to dist/
```

```
src/
  index.ts                       the exports
  federation.ts                  Federation, FederationOptions, Query, QueryResult and Locate
  too-many-databases-error.ts    TooManyDatabasesError
  federation.test.ts             the tests, on real SQLite files
```
