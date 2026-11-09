# Code copied in this package

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. While copies exist, a fix in one copy goes into each copy, and the commit names each file.

## Test helpers in more than two places

**`buildAppStylesheet`.** Three places.

- Places: `src/dialog.test.ts`, `src/sidebar.test.ts` and `src/styles.test.ts`.
- Same: the build of an app stylesheet in the way of the Tailwind CLI.
- Differs: the copy in `src/styles.test.ts` takes the rules of the app.
- Not counted: `src/styles.test.ts` of `packages/diagram` has its own copy, because test helpers of different packages stay copied (root ADR 0001, rule 2).

The Rule of Three asks to move this helper into `src/testing` (backlog #4084).

## In two places

**The arrange step of a sidebar with a trigger.**

- Places: `src/sidebar-cookie.test.ts` and `src/sidebar.test.ts`.
- Same: the import of the package, and a React root that renders the provider, the sidebar and the trigger.
- Why it stays: each test has its own arrange step, and a test has no lifecycle hooks.
