# SQLite federation

A host keeps its data in many SQLite databases, for example one database for each data source. A statement must read some of them together, for example to join messages with contacts. One SQLite connection can attach at most 10 databases, and the SQLite in Node cannot raise that limit. This package gives one read-only handle over a primary database and every additional database that the host can locate. The primary database stays open for the lifetime of the handle. Each statement attaches the additional databases it names and detaches them when it ends.

## Language

**Database**:
A SQLite file that the host gives a name.
_Avoid_: File (the host decides where the file is), store

**Name**:
The schema name that a statement uses for a database, for example `mail` in `mail.messages`.
_Avoid_: Alias, key, id

**Locate**:
The required port of the host. It gives the path of a database for a name, or `undefined` when the host has no database with that name. It is called once for a named main, and for each statement's additional databases.
_Avoid_: Resolve, look up, map

**Main**:
The primary database, opened read-only for the lifetime of the handle. Give its path or `{ name }` to find it through `locate`; `':memory:'` gives an empty primary database. An unknown name fails construction. Main does not count toward the attachment limit.

**Handle**:
`sql` for tagged statements, and `query(sql)` for one SQL string. Both discover additional databases from the statement through `locate`.
_Avoid_: Connection (the handle has one connection, but the connection is not the handle), client, session

**Statement**:
One call of `sql.all`, `sql.get` or `query`.
_Avoid_: Query (a query can have many statements), evaluation

**Attach**:
To open an additional database on the connection of the handle, for one statement.
_Avoid_: Mount, load, open

**Limit**:
The number of databases that one SQLite connection can attach at the same time. It is 10 in the SQLite of Node.
_Avoid_: Cap, maximum, quota
