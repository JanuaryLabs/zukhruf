# Code copied in this package

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. While copies exist, a fix in one copy goes into each copy, and the commit names each file.

## In two places

**The arrange step of a sidebar with a trigger.**

- Places: `src/sidebar-cookie.test.ts` and `src/sidebar.test.ts`.
- Same: the import of the package, and a React root that renders the provider, the sidebar and the trigger.
- Why it stays: each test has its own arrange step, and a test has no lifecycle hooks.

**The walk that finds the enclosing `@layer`.**

- Places: `src/sidebar.test.ts` and `src/styles.test.ts`.
- Same: the walk over the stylesheet that gives the innermost `@layer` before a position.
- Differs: `layerAt` in `src/sidebar.test.ts` takes an index. `layerOf` in `src/styles.test.ts` takes a rule, and the test fails when the rule does not match.
- Backlog: #4101. A third place moves it to `src/testing`.
