# Code copied in this package

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. While copies exist, a fix in one copy goes into each copy, and the commit names each file.

## In two places

**The PATH of a hermetic test environment (test helper).**

- Places: `toolFolders` and `isolatedEnvironment` in `src/testing/hooked-repository.ts`, and `toolFolders` and the `PATH` of `workspace` in `packages/nx/src/testing/workspace.ts` (the source, zukhruf 0668519a, #6131).
- Same: the folder of each named program, found with `command -v`, after the folder of node and before /usr/bin and /bin, so NixOS finds programs that are not in /usr/bin.
- Differs: the programs. This copy names git, npm and tar, which the hook and its tests start; nx names basename, mkdir and rm, which its fixtures' scripts run.
- Until a third place needs it, a fix in one copy goes into the other, and the commit names both files.

**The packages of a probe workspace (test helper).**

- Places: `src/build.test.ts` and `src/push.test.ts`.
- Same: each package gets a link in `node_modules/@probe`, and the repo gets a link to the `nx` of this workspace.

**The start of a probe workspace on the install of this repo (test helper).**

- Places: `src/codegen.test.ts` and `src/sync.test.ts`.
- Same: `node_modules` is a link to the install of this workspace, and the repo gets the `.gitignore` and the `package.json` of an npm workspace.

**`isDockerfile`.**

- Places: `src/no-numeric-pins.ts` and `src/dockerfile-installs.ts`.
- Same: a file whose name is `Dockerfile`, or holds it as a part between dots, in any case, such as `Dockerfile.migration`, `api.Dockerfile` or `dockerfile.api`.

**The lint of staged files with the commit's ESLint.**

- Places: `src/dependency-checks.ts` and `src/workflow-checks.ts`.
- Same: `LintResult` and `isLintResults`, the run of `eslint --format json --no-warn-ignored` in the snapshot, the failure on exit code 2, and the report of each error as `<path>:<line>  <message>  <rule>` with the `npx eslint` command to run.
- Different: `DependencyChecks` lints the `package.json` of each touched project, a deletion included; `WorkflowChecks` lints each staged file under `.github` and skips a deletion.

**A workflow file of `.github`.**

- Places: `src/no-numeric-pins.ts` (`isWorkflow`) and `src/workflow-checks.ts` (`WORKFLOWS`).
- Same: a `.yml` or `.yaml` file under `.github/`.
