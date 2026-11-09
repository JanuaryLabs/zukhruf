# Code copied in this package

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. While copies exist, a fix in one copy goes into each copy, and the commit names each file.

## In two places

A third place is the time to move a scene into `src/testing` (backlog #4085).

**The edges of one scene (test data).**

- Places: `src/lib/layouts/graph/layout-scenarios.test.ts` and `src/lib/renderers/svg/diagram-svg.test.ts`.
- Same: the list of edges from `argocd` to the observability bus.

**The scene with each node kind (test data).**

- Places: `src/lib/renderers/markup-precision.test.ts` and `src/lib/renderers/paint-contract.test.ts`.
- Same: the boxes, the junction and the arrows of the scene.
- Differs: the first group. Its label has two lines in `src/lib/renderers/markup-precision.test.ts`.
