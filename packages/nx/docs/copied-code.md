# Code copied inside the Nx package

Two areas of this package select the same project roots. The `test` area keeps its own copy of the rule of the `format` area, and does not share it yet.

The reason is the Rule of Three. It counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. The boundary of the shared code then comes from three working copies, not from a guess. The third area is expected to be `./portless` (#3336). Backlog #3361 holds the extraction. Until then, a fix in one copy is made in the other copy too, and the commit names both files. This note is the input for that step.

Paths are in `packages/nx/src`.

## Copied with changes

**`format/plugin.ts` → `test/plugin.ts`: the project-root rule.**
The same in both: each folder with a `project.json` is a root. A folder with a `package.json` is a root only when the package-manager workspace globs match it, and when the folder has no `project.json`. The matcher is `buildPackageJsonPatterns` and `buildPackageJsonWorkspacesMatcher` of `@nx/devkit/internal` ([ADR 0003](./adr/0003-which-roots-get-targets.md)).
What changes: the glob of `test` also reads the test files and the Vite and Vitest configs, so the copy first keeps only the `package.json` and `project.json` files.

**`format/plugin.test.ts` → `test/plugin.test.ts`: the `workspace` helper.**
The same in both: an npm workspace in a temp folder, Nx linked from zukhruf, the plugin entry in `nx.json`, and an `nx` runner with a clean environment.
What changes: the `test` copy links Vite and not Prettier, writes no `node_modules/.bin`, and reads the `test` target.

## Extraction plan (third area: `./lint`, #3335)

> Status: design for review. The extraction is done in the build of `./lint`.

The `lint` area also gives inputs to each project root, so it needs the same rule. That is the third place. Thus the rule is extracted now, and not when `./portless` (#3336) comes. The boundary comes from the three working copies:

- **The same in the three places**: from the `project.json` and `package.json` files of the glob, keep each `project.json`, and each `package.json` with no `project.json` next to it that the workspace matcher accepts. This goes into one internal module, `src/project-roots.ts`. It is not an export of the package. It takes the config files and the workspace root, and it gives the root files.
- **Different in each place, so it stays with each area**: the glob. `format` and `lint` read only `package.json` and `project.json`. `test` also reads the test files and the Vite and Vitest configs, so `test` first keeps only the `package.json` and `project.json` files, then calls the module.
- **The targets** stay with each area.

The `workspace` helper of the tests is a third copy too, because the tests of `./lint` need a temp workspace with Nx and `@nx/eslint` linked. Its shared part goes into `src/testing/workspace.ts`, a file of the tests that is not in the package: the temp folder, the npm workspace, Nx linked from zukhruf, the plugin entries in `nx.json`, and the `nx` runner with a clean environment. Different in each place, so it stays with each test file: the packages that it links (Prettier, Vite, `@nx/eslint` and ESLint) and the target that it reads.

After the extraction, the two sections above are deleted, and #3361 is closed.
