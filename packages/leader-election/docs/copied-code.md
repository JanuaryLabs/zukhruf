# Code copied into this package

This package keeps a few small files that other packages also have. Each one is listed here with its source and what changed, so that a fix in one copy goes into each copy, and the commit names all of them.

| Copy                               | Source                                            | What changed                                                                            | Backlog |
| ---------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- | ------- |
| `src/sqlite/is-busy.ts`            | `packages/mutex/src/shared/sqlite/is-busy.ts`     | Nothing.                                                                                | #2517   |
| `src/testing/wait-until.ts`        | `packages/mutex/src/testing/wait-until.ts`        | Nothing.                                                                                | #2509   |
| `src/testing/scratch-directory.ts` | `packages/mutex/src/testing/scratch-directory.ts` | The folder name starts with `election-test-`.                                           | #2509   |
| `src/testing/worker-process.ts`    | `packages/mutex/src/testing/worker-process.ts`    | No `host` and no `nodeOptions` option. The message check is inline, with no `isRecord`. | #2509   |

The test helpers are in three packages now: the mutex, the single flight and this one. The maintainer chose a third copy for them, and backlog #2509 records it. `isBusy` is a check of a SQLite error, not of a file, so it is not in `@zukhruf/fs`. Backlog #2517 tracks its copies.

The election itself is no copy: the mutex and the single flight use this package.
