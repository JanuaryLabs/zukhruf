# The error of SQLite names the database

The handle must know which databases a statement reads before it can attach them. When a statement names a schema that is not attached, SQLite fails with `no such table: <name>.<table>` for a table, or `unknown database <name>` for a PRAGMA. That error gives the name. The handle attaches the database with that name and runs the statement again. It does this again for each name that is missing. The handle never parses the statement.

For a PRAGMA, SQLite's [`sqlite3TwoPartName`](https://github.com/sqlite/sqlite/blob/master/src/build.c) puts the original schema token in the error, including its quotes. A table-valued PRAGMA reports the schema as a quoted string. The handle removes the surrounding quotes and decodes doubled quote characters before calling `locate`; bare names remain unchanged.

A name that the host cannot locate fails with the error of SQLite. A table that a database does not have also fails with that error, because the handle does not attach a database two times in one statement.

## Considered Options

- **Parse the statement and find each schema name.** The package must then know the full grammar of SQLite, for example common table expressions, subqueries and quoted names.
- **Each condition declares its databases.** The list can differ from the SQL.
- **The error of SQLite names each missing database.** This option was selected.

## Consequences

- The handle depends on the words of the error of SQLite. The test "a statement reads a database that it names by schema" fails if those words change in a new Node or SQLite.
- A statement runs one time for each database that is not attached, plus one time. Table and direct PRAGMA discovery fail during preparation. A table-valued PRAGMA can report its missing schema during execution, including when the schema is a bound parameter.
- For a table error, the name is the text before the first dot. Table discovery therefore cannot resolve a schema name containing a dot. PRAGMA errors include the complete schema token.
- Cross-database tables must be qualified. Unqualified tables do not tell `locate` which database to open; the handle does not enumerate databases or impose an attachment order. Primary tables and temporary views, including views that qualify their own dependencies, remain accessible without a schema prefix.
