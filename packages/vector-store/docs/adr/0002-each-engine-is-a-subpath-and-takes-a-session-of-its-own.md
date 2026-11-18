# Each engine is a subpath, and takes a session of its own

Status: proposed, for Ezz's review (2026-11-18).

Each engine speaks to another driver: `node:sqlite` is synchronous, `pg` numbers its parameters (`$1`), and `mssql` names them (`@q`). A host already has its own connection, its pool and its credentials.

## Considered Options

| Choice                                      | Who does it                                                                                                                    | Cost                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| The package imports and opens the driver    | Mastra `@mastra/pg` takes a connection string                                                                                  | Every consumer installs every driver, or the package needs optional peers; the host loses its pool  |
| The package borrows the host's provider     | MemberJunction `ai-vectors-sqlserver` uses `IColocatedVectorHost` of its own data provider                                     | It works only inside that platform                                                                  |
| One generic SQL session for all engines     | none                                                                                                                           | The parameter syntax and the sync and async calls differ, so the session would lie about one engine |
| Each engine names the methods that it calls | `@zukhruf/mutex`: `SqlServerSession`, "only the methods that the store calls" (`src/lock-stores/sqlserver/sqlserver-store.ts`) | The host writes a small wrapper for `mssql`                                                         |

## Decision

- `@zukhruf/vector-store/sqlite`: `new SqliteVectorStore({ database })`, where `database` is a `DatabaseSync` of `node:sqlite`.
- `@zukhruf/vector-store/sqlite-vec`: `new SqliteVecVectorStore({ database })`. The caller loads the extension (`database.loadExtension(sqliteVec.getLoadablePath())`), as `@deepagents/retrieval` does in `stores/sqlite/open.ts`.
- `@zukhruf/vector-store/postgres`: `new PostgresVectorStore({ session })`, where `session.query(text, values)` gives `{ rows }`. `pg.Pool` and `pg.Client` have this shape. The host creates the extension (`CREATE EXTENSION vector`), because that needs a right that the package must not ask for.
- `@zukhruf/vector-store/sqlserver`: `new SqlServerVectorStore({ session })`, where `session.query(sql, parameters)` gives the rows, and `parameters` names each value as `@name` does.
- The package has no driver in `dependencies`. The tests install `pg` and `tedious` as dev dependencies, as the mutex does.
- The tests start Postgres from the image `pgvector/pgvector:pg18` and SQL Server from `mcr.microsoft.com/mssql/server:2025-latest`, through the `image` option of `@zukhruf/testing`'s `Postgres` and `SqlServer`. The default SQL Server image of `@zukhruf/testing` is 2022, which has no `VECTOR` type.

## Consequences

- A store of an engine with no subpath is a new subpath, not an option of an old one.
- A wrapper of the host can log, time or retry each call, because each call goes through it.
