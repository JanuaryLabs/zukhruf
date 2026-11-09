# Code copied in this package

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. While copies exist, a fix in one copy goes into each copy, and the commit names each file.

## In two places

**The packages of a probe workspace (test helper).**

- Places: `src/build.test.ts` and `src/push.test.ts`.
- Same: each package gets a link in `node_modules/@probe`, and the repo gets a link to the `nx` of this workspace.

**The start of a probe workspace on the install of this repo (test helper).**

- Places: `src/codegen.test.ts` and `src/sync.test.ts`.
- Same: `node_modules` is a link to the install of this workspace, and the repo gets the `.gitignore` and the `package.json` of an npm workspace.
