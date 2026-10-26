# Keep rows rebuilds a table and keeps its references

[ADR 0002](./0002-a-stale-object-replaces-the-whole-declaration.md) lets `apply` replace every object of a stale declaration, and the rows are gone. Six callers in other repositories must keep their rows. Each one has its own code that makes a stored table fit its declaration and keeps the rows. Three of these copies have bugs. One copy deletes the rows of child tables through an `ON DELETE CASCADE`. Thus `new Declaration(statements, { rows })` takes `rows: 'keep'`, and `apply` then rebuilds each stale table. `rows` has no default, so no caller loses rows because it forgot an option.

SQLite cannot change a CHECK, a type or a constraint in place. "Making Other Kinds Of Table Schema Changes" on [the ALTER TABLE page](https://www.sqlite.org/lang_altertable.html) gives 12 steps: turn foreign keys off, start a transaction, make a new table `X_next`, copy the rows, drop `X`, rename `X_next` to `X`, make the indexes, triggers and views again, run `PRAGMA foreign_key_check`, commit, and turn foreign keys on.

We tested this order on SQLite 3.53.4 (in Node 26.10):

- `DROP TABLE X` fails while a view refers to `X`: `error in view …: no such table`.
- After the rename, `sqlite_schema` stores `CREATE TABLE "X" (…)`, with quotes. This text is not the declared text, so `drift` gives `stale` for all time ([ADR 0001](./0001-compare-the-text-that-sqlite-stores.md)).

Thus `apply` renames the old table away first:

1. It keeps the SQL of the indexes and triggers on `X` that the declaration does not name.
2. It turns `PRAGMA legacy_alter_table` on. With this pragma, the rename does not change the references to `X` in other tables, views and triggers.
3. It renames `X` to a name that cannot clash, and runs the declared CREATE text. SQLite stores the declared text exactly.
4. It copies the columns that both tables have, by name. A column that only the declaration has gets its default. A column that only the old table has is discarded.
   - When both tables have a rowid, it also copies the rowid. It reads and writes the rowid through the first name of `rowid`, `_rowid_` and `oid` that no column has. A `WITHOUT ROWID` table has no rowid. The rowid is first in the column list. When the list also has the `INTEGER PRIMARY KEY` column of the new table, SQLite uses the later value, so that column keeps its own values. A new `INTEGER PRIMARY KEY` column that the old table does not have gets the old rowids.
   - When the declared table has `AUTOINCREMENT`, it keeps the old row of `sqlite_sequence`. The rename moves that row to the old name. After the copy, the new table gets the old value. The copy gives no id larger than the old value.
5. It drops the old table, and runs the kept index and trigger SQL again. Then `apply` makes the declared objects that are missing.
6. It runs `PRAGMA foreign_key_check`. A row that it finds makes `apply` fail, and the transaction rolls back.

We tested more facts:

- With foreign keys off, the references in child tables stay on `X`, the rows are copied, `foreign_key_check` finds no row, and an `ON DELETE CASCADE` from `X` works after the rebuild.
- With foreign keys on, SQLite changes the references in child tables to the new name of the old table, also with `legacy_alter_table` on. The drop of the old table then deletes the rows of the children and of their children.
- `PRAGMA foreign_keys` does nothing in a transaction. `PRAGMA legacy_alter_table` changes in a transaction, and a rollback does not undo it. Thus `apply` sets the old value again in a `finally`.
- The indexes and triggers on `X` move with the rename, and the drop of the old table drops them. Thus `apply` makes them again.
- When a stored row does not fit the new table (NOT NULL, CHECK, a foreign key, STRICT), the copy fails with the error of SQLite, for example `NOT NULL constraint failed: runs.name`. The rollback restores the table and its rows.
- A copy of the columns gives new rowids, because `pragma_table_info` does not list the rowid. A table with no `INTEGER PRIMARY KEY` changed the rowids `2, 3` to `1, 2`, and an external-content FTS5 index that refers to the rowids then found the wrong rows.
- A copy of the columns does not copy `sqlite_sequence`. After the rebuild, an `AUTOINCREMENT` table gave the id of a deleted row again.
- A module keeps the data of a virtual table in its own way. An external-content FTS5 index keeps the rowids of its content table, and a `vec0` table keeps the vectors in chunks of a declared size. A copy of the rows cannot keep these safely. Thus `apply` does not rebuild a stale virtual table. It fails before it changes the database, and tells the caller to give the virtual table its own declaration with `rows: 'replace'`.

The foreign-key rule: when foreign keys are on, and a table (the stale table too) has a foreign key to a stale table, `apply` must turn foreign keys off. When `apply` owns the transaction, it turns them off before `BEGIN` and on again after the transaction. In a transaction of the caller, `apply` cannot turn them off, so it fails before it changes anything. When no table refers to the stale table, `apply` rebuilds it with foreign keys on, also in a transaction of the caller.

## Considered Options

- **The order of SQLite: make `X_next`, drop `X`, rename.** The drop fails while a view refers to `X`, and the stored text has quotes, so `drift` gives `stale` for all time.
- **`PRAGMA defer_foreign_keys` in place of foreign keys off.** We tested it. The drop of the old table still deletes the rows of the children.
- **Always own the transaction.** `apply` would fail in every transaction of a caller. A caller whose stale table no table refers to does not need foreign keys off, so it can rebuild in its own transaction.
- **`ALTER TABLE ADD COLUMN` when the change is only a new column.** SQLite then stores a text that can be different from the declared text, so `drift` can give `stale` after `apply`. `apply` always rebuilds.
- **A map of renamed columns, or SQL that fills values.** sqlite-utils `table.transform()` takes a rename map. No caller copy needs one, so `apply` has none (Rule of Three). A caller runs its own SQL before `apply`.
- **Rename the old table away with `legacy_alter_table` on.** This option was selected.

## Consequences

- With `rows: 'keep'`, a stale table keeps its rows, and the rows of the tables that refer to it stay.
- A kept row keeps its rowid, and an `AUTOINCREMENT` table does not give an old id again.
- With `rows: 'keep'`, a stale virtual table makes `apply` fail. The caller declares it alone with `rows: 'replace'`, and fills it again.
- `drift` gives `fits` after `apply`, because SQLite stores the declared text.
- A renamed column reads as one column dropped and one column added. The values of the old column are discarded.
- A stored row that does not fit the declaration makes `apply` fail with the error of SQLite. The caller changes or removes the row before `apply`.
- In a transaction of the caller, with foreign keys on, `apply` fails when a table refers to a stale table.
- SQLite does not examine the body of a trigger or a view at `CREATE`, so a rebuild can leave a trigger or a view that names a dropped column. `apply` compiles a `DELETE`, an `INSERT` and an `UPDATE` of each rebuilt table, and each view. When a trigger does not compile, or a view compiled before the rebuild and does not compile after it, `apply` fails and the transaction rolls back.
- A trigger can read a table that is not its own table, so a rebuild can break a trigger on another table. A replace with `rows: 'replace'` can break it too. Thus `apply` uses the rule of the views for the triggers of all tables, with each `rows` option. Before the change, it records which tables with triggers in `sqlite_schema` compile a `DELETE`, an `INSERT` and an `UPDATE`. After the change, it compiles them again. When a table compiled them before and does not compile them now, `apply` fails with the error of SQLite, and the transaction rolls back. `apply` does not read the text of a trigger to find the tables that it reads ([ADR 0001](./0001-compare-the-text-that-sqlite-stores.md)).
- `apply` with `rows: 'replace'` does what ADR 0002 tells.
