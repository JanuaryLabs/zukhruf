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
5. It drops the old table, and runs the kept index and trigger SQL again. Then `apply` makes the declared objects that are missing.
6. It runs `PRAGMA foreign_key_check`. A row that it finds makes `apply` fail, and the transaction rolls back.

We tested more facts:

- With foreign keys off, the references in child tables stay on `X`, the rows are copied, `foreign_key_check` finds no row, and an `ON DELETE CASCADE` from `X` works after the rebuild.
- With foreign keys on, SQLite changes the references in child tables to the new name of the old table, also with `legacy_alter_table` on. The drop of the old table then deletes the rows of the children and of their children.
- `PRAGMA foreign_keys` does nothing in a transaction. `PRAGMA legacy_alter_table` changes in a transaction, and a rollback does not undo it. Thus `apply` sets the old value again in a `finally`.
- The indexes and triggers on `X` move with the rename, and the drop of the old table drops them. Thus `apply` makes them again.
- When a stored row does not fit the new table (NOT NULL, CHECK, a foreign key, STRICT), the copy fails with the error of SQLite, for example `NOT NULL constraint failed: runs.name`. The rollback restores the table and its rows.

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
- `drift` gives `fits` after `apply`, because SQLite stores the declared text.
- A renamed column reads as one column dropped and one column added. The values of the old column are discarded.
- A stored row that does not fit the declaration makes `apply` fail with the error of SQLite. The caller changes or removes the row before `apply`.
- In a transaction of the caller, with foreign keys on, `apply` fails when a table refers to a stale table.
- `apply` with `rows: 'replace'` does what ADR 0002 tells.
