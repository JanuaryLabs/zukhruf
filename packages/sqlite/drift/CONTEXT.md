# SQLite drift

A package keeps tables, indexes, views and triggers in a SQLite database. A later version of the package can declare them otherwise, for example with one more column. The database still stores the objects as the earlier version made them. This package compares the stored objects with their declaration, and makes the database store them as declared.

## Language

**Declaration**:
The CREATE statements of the objects that one caller owns in a database.
_Avoid_: Schema (in SQLite, a schema is one attached database, for example `main`), layout, version

**Object**:
A table, an index, a view or a trigger that `sqlite_schema` lists.
_Avoid_: Relation (a relation is a table or a view only), entity

**Drift**:
How the database stores the objects of a declaration: `missing` when it stores none of them, `fits` when it stores each one as declared, and `stale` for all other cases.
_Avoid_: Mismatch, diff, outdated

**Apply**:
To make the database store each object of a declaration as declared.
_Avoid_: Migrate (apply converts no rows), sync, install

**Replace**:
To drop a stored object and make it again from its declaration. The rows of a replaced table are gone.
_Avoid_: Reset, recreate (a rebuild keeps the rows)

**Keep**:
The `rows` option of a declaration that makes `apply` rebuild each stale table and not replace it.
_Avoid_: Migrate (keep converts no values), preserve

**Rebuild**:
To rename a stored table away, make it from its declaration, copy the rows of the columns that both have, and drop the old table. The references of other tables to the name stay.
_Avoid_: Replace (a replaced table loses its rows), transform, recreate
