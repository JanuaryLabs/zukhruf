# A statement owns the objects its CREATE makes

A declaration makes its objects in an empty database in memory, and reads them back from `sqlite_schema` ([ADR 0001](./0001-compare-the-text-that-sqlite-stores.md)). Before this decision, it read every row of `sqlite_schema`. Some statements add more than one row. We tested these statements on SQLite 3.53.4 (in Node 26.10):

- `CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, u UNIQUE)` adds `jobs`, an index with no SQL for `UNIQUE`, and `sqlite_sequence`.
- `CREATE VIRTUAL TABLE m_fts USING fts5(body)` adds `m_fts` and the four shadow tables `m_fts_data`, `m_fts_idx`, `m_fts_docsize` and `m_fts_config`. With no `content` option, it also adds `m_fts_content`.
- `CREATE VIRTUAL TABLE vc USING vec0(embedding float[4])` adds `vc`, `vc_info`, `vc_chunks`, `vc_rowids`, `vc_vector_chunks00`, and indexes with no SQL.

The extra rows became objects of the declaration. This caused three bugs:

1. With `rows: 'replace'`, a stale `AUTOINCREMENT` table made `apply` fail with `table sqlite_sequence may not be dropped`.
2. With `rows: 'replace'`, a stale virtual table made `apply` fail with `table m_fts_config may not be dropped`.
3. When another table had made `sqlite_sequence`, `drift` gave `stale` and not `missing` for an `AUTOINCREMENT` declaration that the database did not store.

SQLite makes these rows with the object of the statement, and drops them with it. Thus a statement owns them. The first row that a statement adds is its declared object. Each other row that it adds is an owned object. `drift` compares, and `apply` drops and makes, only declared objects.

To know which rows a statement adds, the declaration must run each statement alone. The constructor runs each string with `prepare(...).run()`. `prepare` compiles only the first statement of a text and ignores the rest. Thus the constructor compiles the rest of the text too. When the rest compiles, the string holds a second statement, and the constructor fails. When the rest holds only spaces, comments and semicolons, `node:sqlite` throws `The SQL query contains no statements.`, and the string is correct. A string that adds no row, for example `CREATE TABLE IF NOT EXISTS` of a declared table, a `TEMP` table or an `INSERT`, makes the constructor fail too.

## Considered Options

- **Skip the rows whose names start with `sqlite_`.** This fixes `sqlite_sequence` only. The shadow tables of a virtual table have the name of the virtual table first.
- **Skip the rows that `PRAGMA table_list` gives the type `shadow`.** We tested it. It finds the FTS5 shadow tables, but not the `vec0` table `vc_vector_chunks00`.
- **Run the whole text with `exec`, and permit more than one statement in a string.** Then the declaration cannot know which statement added which row.
- **The first row that a statement adds is its declared object, and the other rows are owned objects.** This option was selected. It needs no list of modules and no rule about names.

## Consequences

- Each string of a declaration holds one statement, and the statement makes one object. Two statements, or a statement that makes no object, make `new Declaration` fail.
- `drift` gives `missing` for an absent `AUTOINCREMENT` table, also when another table made `sqlite_sequence`.
- With `rows: 'replace'`, a stale `AUTOINCREMENT` table or a stale virtual table is replaced. The drop of the declared object drops its owned objects.
- `apply` does not drop `sqlite_sequence`. SQLite keeps it after the drop of the last `AUTOINCREMENT` table, and it does no harm.
