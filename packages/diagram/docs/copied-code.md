# Code copied into this package

This package has one function in two files. The copy is listed here with its source and what changed, so that a fix in one copy goes into the other copy.

| Copy                                                        | Source                                                    | What changed | Backlog |
| ----------------------------------------------------------- | --------------------------------------------------------- | ------------ | ------- |
| `endpointNodeId` in `src/lib/layouts/graph/graph-layout.ts` | `endpointNodeId` in `src/lib/compiler/diagram-compile.ts` | Nothing.     | #2710   |

Until a third place needs this function, put each fix into the two copies, and name the two files in the commit. Backlog #2710 moves the function into one module when a third place needs it.
