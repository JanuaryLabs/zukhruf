# Code copied into this package

This package keeps a few small files that other packages also have. Each one is listed here with its source and what changed, so that a fix in one copy goes into each copy, and the commit names all of them.

| Copy                               | Source                                            | What changed                                                                            | Backlog |
| ---------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- | ------- |
| `src/sqlite/is-busy.ts`            | `packages/mutex/src/shared/sqlite/is-busy.ts`     | Nothing.                                                                                | #2517   |
| `src/testing/wait-until.ts`        | `packages/mutex/src/testing/wait-until.ts`        | Nothing.                                                                                | #2509   |
| `src/testing/scratch-directory.ts` | `packages/mutex/src/testing/scratch-directory.ts` | The folder name starts with `election-test-`.                                           | #2509   |
| `src/testing/worker-process.ts`    | `packages/mutex/src/testing/worker-process.ts`    | No `host` and no `nodeOptions` option. The message check is inline, with no `isRecord`. | #2509   |

The test helpers are in three packages now: the mutex, the single flight and this one. The maintainer chose a third copy for them, and backlog #2509 records it. `isBusy` is a check of a SQLite error, not of a file, so it is not in `@zukhruf/fs`. Backlog #2517 tracks its copies.

## The election is in three places

This package is the election of the mutex, made into one campaign with a subclass for each backend. The mutex and the single flight do not use it yet: the maintainer put that step on hold (backlog #2530). Until they use it, each of them keeps its own copy. A fix to the election goes into each of the three places, and the commit names each file.

| Place         | Files                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------ |
| This package  | `src/leader-election.ts`, `src/term.ts`, `src/sqlite/sqlite-election.ts`                   |
| Mutex         | `packages/mutex/src/leader-election/leader-election.ts`, `leadership.ts`                   |
| Single flight | `packages/single-flight/src/election/leader-election.ts`, `leadership.ts` (its own ledger) |

What changed from the mutex's copy:

- The campaign is the abstract class `LeaderElection`. The SQLite claim is its subclass `SqliteElection`.
- The claim file and the epoch file are options (`claimFile`, `epochFile`). The mutex uses `leader.lock` and `leader.epoch`. The single flight uses `flight.lock` and `flight.epoch`.
- `Leadership` is `Term`. A term has a `signal` that aborts with `TermLostError` when the backend takes the claim away. A second `resign` waits for the first.
- `campaign` takes a `signal`, and a claim won after it aborted is given up.
