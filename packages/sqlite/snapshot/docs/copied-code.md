# Code copied into this package

This repository follows the Rule of Three, and it counts places. A second place copies the code, and this note records the copy. While both copies exist, put each fix into both copies, and name both files in the commit. A third place that needs the code is the time to extract it.

| Copy                        | Source                                                       | What changed                                                                                                                                                                                                          | Backlog                      |
| --------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `open` in `src/snapshot.ts` | `open` in `packages/sqlite/data-version/src/data-version.ts` | Both copies came from `AppDatabase` and `AppDatabaseVersion` of context-compiler (commit 3a1c829). Both copies no longer map `SQLITE_AUTH` (23): SQLite gives it only for an authorizer, and the connection has none. | — (extract at a third place) |

`open` opens a database read-only, and changes `SQLITE_CANTOPEN` (14) into the unavailable error of the caller. `@zukhruf/sqlite-snapshot` and `@zukhruf/sqlite-data-version` are used without each other, so neither package imports the other.
