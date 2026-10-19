# A statement over the limit fails

One SQLite connection can attach at most 10 databases. SQLite sets this limit when it is compiled, and `sqlite3_limit` can only make it lower. The SQLite in Node is compiled with the default of 10. Some hosts run on a Node that they cannot change, and some of these accept no native code. Such a host cannot load a SQLite extension or a native addon with a higher limit. Thus this package uses only the SQLite in Node.

A statement that names more than 10 databases fails with `TooManyDatabasesError`. The error gives the names, and it tells the author to split the statement. A condition is code, so it can run two statements and join their rows in JavaScript.

## Considered Options

- **A SQL function that reads one database on its own connection and returns its rows as JSON.** The author writes `FROM json_each(rows('mail', 'SELECT …'))`, and reads each field with `->>`. This works in Node 24.21. A probe measured 83 ms for 10 databases, and 12 ms with ATTACH. The author must know about JSON, and all the rows of a call are in memory as one string.
- **A virtual table for each database, made with `createModule()`.** Node 26.11.0 added this API. Node 24.22.0 does not have it, and the first host of this package ran on Node 24.
- **A SQLite that we compile with a higher limit, in a helper program.** The host must then ship and build native code.
- **Fail, and tell the author to split the statement.** This option was selected.

## Consequences

- No condition reads more than 10 databases in one statement yet. When one must, and the host runs on Node 26.11 or later, a table-valued function made with `createModule()` can read the other databases.
- `TooManyDatabasesError` gives at least 11 names: the 10 attached databases and the one that was not attached. The statement can name more.
