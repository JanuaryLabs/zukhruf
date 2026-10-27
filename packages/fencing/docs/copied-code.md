# Code copied in this package

This package keeps code that another place also has. Each copy is listed here with its source and what changed, so that a fix in one copy goes into each copy, and the commit names all of them.

| Copy                                                  | Source                                                              | What changed                                                                                                                             | Backlog                      |
| ----------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `refuseSync` in `src/file-token-source.test.ts`       | `refuseSync` in `packages/fs/src/replace-in-one-step.test.ts`       | Nothing. The two copies are byte-identical.                                                                                              | — (test helpers stay copied) |
| `recordDiskWrites` in `src/file-token-source.test.ts` | `recordDiskWrites` in `packages/fs/src/replace-in-one-step.test.ts` | It is in three places. [The ledger of the election](../../election/docs/copied-code.md#test-helpers-in-more-than-two-places) records it. | — (test helpers stay copied) |

`refuseSync` makes `sync` fail with an error code on each handle that `open` gives for a path that the test refuses. It replaces `open` of `node:fs/promises` with `t.mock.method`. Test helpers stay copied ([ADR 0001 of zukhruf](../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md), rule 2). On 2026-10-26 the maintainer moved some test helpers into `@zukhruf/testing`, but not a helper that uses the `mock` of `node:test`. Thus `refuseSync` stays a copy.
