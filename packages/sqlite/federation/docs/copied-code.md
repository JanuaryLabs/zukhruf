# Code copied into this package

This repository follows the Rule of Three, and it counts places. A second place copies the code, and this note records the copy. While both copies exist, put each fix into both copies, and name both files in the commit. A third place that needs the code is the time to extract it.

| Copy                                             | Source                                                | What changed                                                                                                                                                     | Backlog                      |
| ------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| The tail check of `query` in `src/federation.ts` | `holds` in `packages/sqlite/drift/src/declaration.ts` | The copy is inline, and it gives `another`. Both copies take an empty statement (Node 24) and an `ERR_INVALID_ARG_VALUE` from prepare (Node 26) as no statement. | — (extract at a third place) |

The check prepares the text after the first statement, and says whether that text holds a statement. `@zukhruf/sqlite-federation` and `@zukhruf/sqlite-drift` are used without each other, so neither package imports the other.
