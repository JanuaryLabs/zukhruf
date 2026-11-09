# Code copied in this package

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. While copies exist, a fix in one copy goes into each copy, and the commit names each file.

## In two places

**The arrange step of a sidebar with a trigger.**

- Places: `src/sidebar-cookie.test.ts` and `src/sidebar.test.ts`.
- Same: the import of the package, and a React root that renders the provider, the sidebar and the trigger.
- Why it stays: each test has its own arrange step, and a test has no lifecycle hooks.
