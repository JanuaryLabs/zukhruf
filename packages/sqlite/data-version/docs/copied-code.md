# Code copied into this package

This repository follows the Rule of Three, and it counts places. A second place copies the code, and this note records the copy. While both copies exist, put each fix into both copies, and name both files in the commit. A third place that needs the code is the time to extract it.

| Copy                                                   | Source                                                                      | What changed                                                                                                | Backlog                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `open` and `unavailableCodes` in `src/data-version.ts` | `open` and `unavailableCodes` in `packages/sqlite/snapshot/src/snapshot.ts` | Nothing. Both copies came from `AppDatabase` and `AppDatabaseVersion` of context-compiler (commit 3a1c829). | — (extract at a third place) |

`open` opens a database read-only, and changes `SQLITE_CANTOPEN` (14) and `SQLITE_AUTH` (23) into the unavailable error of the caller. `@zukhruf/sqlite-snapshot` and `@zukhruf/sqlite-data-version` are used without each other, so neither package imports the other.
