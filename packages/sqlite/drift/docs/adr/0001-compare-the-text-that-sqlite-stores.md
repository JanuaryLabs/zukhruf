# Compare the text that SQLite stores

The first callers of this package kept a layout number in each database file. A person raised the number when a change made the stored tables different. A new number made the callers start again with empty databases. In one project, the number went from 2 to 8 in 12 days. Of 7 changes that needed a new number, 5 got it late. Each late number broke the databases, for example with `no such column` in 14 of 15 databases.

The number was a second copy of a fact that the database already keeps. SQLite keeps the text of each CREATE statement in `sqlite_schema`. SQLite changes the start of the text: it removes `IF NOT EXISTS` and `TEMP`, and it changes the spaces after the first two keywords. After the name of the object, the text is the same as the statement. Thus a declaration makes its objects once in an empty database in memory, the dev database, and reads the text back. The declared text and the stored text come from the same SQLite, so they are equal when the objects are equal. A SQLite writer of the first callers compared stored text in this way before this package.

## Considered Options

- **A number that a person raises.** People forget to raise it, as the history above shows. Android Room keeps a number too, but it also stores a hash of the declaration, and it fails with "Looks like you've changed schema but forgot to update the version number" (`RoomConnectionManager.kt`). The hash does the work, and the number adds only a way to forget.
- **A hash of the declaration in `PRAGMA user_version`.** It finds every change, but it is one more copy of what `sqlite_schema` keeps. A file that another program changed has the hash but not the objects.
- **The columns that `pragma_table_info` gives.** A Postgres writer must compare columns in this way, because Postgres keeps no CREATE text. In SQLite, this misses a change to a CHECK, to STRICT, or to an index.
- **The text of a copy in memory.** This option was selected. It is the method of "Simple declarative schema migration for SQLite" (David Röthlisberger and William Manley, 2022).

## Consequences

- No person keeps a number. A change to a CREATE statement is a change of drift.
- A declaration must stand alone in the dev database. A trigger or an index on a table that the declaration does not name fails when the declaration is made.
- A statement that uses a module, a function or a collation that the dev database does not have fails when the declaration is made. The caller gives a dev database that has them ([ADR 0005](./0005-the-caller-can-give-the-dev-database.md)).
- A change of meaning with no change of text is not drift. When the meaning of a column changes, change its name too.
- Each check reads `sqlite_schema` once for each object. It needs no write lock, so it also works on a database opened read-only.
