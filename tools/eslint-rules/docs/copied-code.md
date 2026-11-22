# Code copied into this project

The tests of the pg-boss citation rules write a fixture workspace with the helper of packages/eslint's rule tests. Test helpers in different packages stay copied, also after the third copy, because a package does not export its test support ([root ADR 0001](../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md)). A fix in one copy goes into the other copy too, and the commit names both files.

| Copy                                                  | Source                                             | What changed |
| ----------------------------------------------------- | -------------------------------------------------- | ------------ |
| `tools/eslint-rules/src/testing/fixture-workspace.ts` | `packages/eslint/src/testing/fixture-workspace.ts` | Nothing      |

## Copies inside this project

The rules and the codemod each read the pin and the pinned dist. Three helpers have two copies each (Rule of Three, strike 2), so they stay copied until a third place needs one (#5312 tracks it). A fix in one copy goes into the other too, and the commit names both files.

| Copy                                               | Source                                                 | What changed                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `src/pg-boss-citations/repoint.ts` `pinnedVersion` | `src/pg-boss-citations/cited-lines.ts` `pinnedVersion` | Takes the path of the manifest, not of a source file, and throws where the rule gives undefined |
| `src/pg-boss-citations/repoint.ts` `lineCount`     | `src/pg-boss-citations/pinned-dist.ts` `lineCount`     | Reads the file itself, where the source takes its text                                          |
| `src/pg-boss-citations/repoint.ts` `jsFiles`       | the listing in `src/pg-boss-citations/pinned-dist.ts`  | A function of its own                                                                           |
