# Code copied into this package

This package keeps a few small files and checks that other packages also have. Each one is listed here with its source and what changed, so that a fix in one copy goes into each copy, and the commit names all of them.

| Copy                                                                | Source                                                          | What changed                                                                               | Backlog                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `src/testing/new-process-timeout.ts`                                | `packages/mutex/src/testing/new-process-timeout.ts`             | Nothing.                                                                                   | #2509                                                |
| `src/testing/worker-process.ts`                                     | `packages/mutex/src/testing/worker-process.ts`                  | No `host` and no `nodeOptions` option. The message check is inline, with no `isRecord`.    | #2509                                                |
| The decimal check in `readEpoch` of `src/sqlite/sqlite-election.ts` | `FencingToken.parse` in `packages/fencing/src/fencing-token.ts` | The check is inline in `readEpoch`. It throws a `SyntaxError` instead of returning `null`. | — (root ADR 0001 rule 4: a tiny helper stays a copy) |

The test helpers are in three packages now: the mutex, the single flight and this one. The temporary directory of the tests is `TemporaryFiles` of `@zukhruf/testing/fs`, so this package keeps no copy of `scratch-directory.ts`. The maintainer chose a third copy for them, and backlog #2509 records it. The claim of `SqliteElection` is a `FileLock` of `@zukhruf/fs`, so this package keeps no copy of the SQLite result-code checks.

The epoch file holds decimal digits, as each counter file of `@zukhruf/fencing` does. ADR 0001 of `@zukhruf/fencing` says that an election does not depend on that package, so this package keeps a copy of the decimal check of `FencingToken.parse`. Rule 4 of the root ADR 0001 keeps such a tiny helper as a copy.

## The election is in one place

This package is the election of the mutex and the single flight, made into one campaign with a subclass for each backend. Both packages use it since 2026-10-10, and their copies are deleted. Thus no other package keeps a copy of the election now.

What changed from the copies that the mutex and the single flight had:

- The campaign is the abstract class `LeaderElection`. The SQLite claim is its subclass `SqliteElection`.
- The claim file and the epoch file are options (`claimFile`, `epochFile`). The mutex uses `leader.lock` and `leader.epoch`. The single flight uses `flight.lock` and `flight.epoch`.
- `Leadership` is `Term`. A term is a lease of `@zukhruf/lease`: its `signal` aborts with `LeaseLostError` when the backend takes the claim away. A second `resign` waits for the first.
- `campaign` takes a `signal`, and a claim won after it aborted is given up.
- The claim is a `FileLock` of `@zukhruf/fs`. Its journal is in memory, so a leader that dies leaves no `<claimFile>-journal` file. The locks are the same as with the default journal.

## Test helpers in more than two places

Three test helpers are in the tests of this package and in the tests of two other packages. Root ADR 0001 (rule 2) keeps test helpers as copies, also after the third copy. [Testing ADR 0016](../../testing/docs/adr/0016-a-test-helper-goes-into-an-area-when-three-repositories-have-its-knowledge-and-it-does-not-use-mock.md) makes one exception: a test helper goes into `@zukhruf/testing` when three or more repositories have its knowledge and it does not use the `mock` of `node:test`. These three helpers are not in that exception. `recordDiskWrites` and `mountAs` replace functions of `node:fs/promises` with `t.mock`. `LosableElection` is only in this repository. Also, no package exports a shared test module. Thus each helper stays a copy. A fix to one place goes into each place, and the commit names each file.

**`recordDiskWrites`.** Three places.

- Places: `packages/election/src/sqlite/sqlite-election.test.ts`, `packages/fencing/src/file-token-source.test.ts` and `packages/fs/src/replace-in-one-step.test.ts`.
- Same: the type `DiskEvent`, and the record of each `writeFile` and `sync` of a handle that `open` gives, and of each `rename`. The helper replaces `open` and `rename` of `node:fs/promises` with `t.mock.method`, and then calls `syncBuiltinESMExports`. Each call still goes to the real disk. `Symbol.dispose` restores the mocks.
- Differs: the copies in fencing and fs are byte-identical, but the comment in fs has two more lines. These lines name the other two places and this ledger. The copy in this package has no `replacementIn`, and its comment does not name the Node APIs that it pins.

**`mountAs` and `within`.** Three places.

- Places: `packages/election/src/sqlite/sqlite-election.test.ts`, `packages/fs/src/local-directory.test.ts` and `packages/mutex/src/lock-stores/network-directory.test.ts`.
- Same: `within` tells if a path is a directory or is in that directory. `mountAs` takes `t`, and makes `statfs` give `type` for the directory and for each path in it, as a mount of that file system does. Each other path gets the real answer.
- Differs: the code is byte-identical. The comment in fs has two more lines that name the other two places and this ledger.

**`LosableElection`.** Three places.

- Places: `packages/election/src/sqlite/sqlite-election.test.ts`, `packages/mutex/src/lock-stores/socket/lock-server.test.ts` and `packages/single-flight/src/coordinator/flight-server.test.ts`.
- Same: a subclass of `SqliteElection` that takes a `loss` signal. Its `watch` calls `lose` when `loss` aborts. SQLite never takes the claim from a leader that lives, so only this backend shows what a lost term does.
- Differs: the claim file and the epoch file. This package uses `term.lock` and `term.epoch`, the mutex uses `leader.lock` and `leader.epoch`, and the single flight uses `flight.lock` and `flight.epoch`. The mutex and the single flight also set `pollInterval: 10`. The comment names the tests of each package.
