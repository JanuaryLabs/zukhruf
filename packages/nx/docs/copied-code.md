# Code copied inside the Nx package

The tests of two areas of this package make the same temp workspace. The test file of the `test` area keeps its own copy of the `workspace` helper of the `format` area, and does not share it yet.

The reason is the Rule of Three. It counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. The boundary of the shared code then comes from three working copies, not from a guess. Backlog #3361 holds the extraction. Until then, a fix in one copy is made in the other copy too, and the commit names both files. This note is the input for that step.

Paths are in `packages/nx/src`.

## Copied with changes

**`format/plugin.test.ts` → `test/plugin.test.ts`: the `workspace` helper.**
The same in both: an npm workspace in a temp folder, Nx linked from zukhruf, the plugin entry in `nx.json`, and an `nx` runner with a clean environment.
What changes: the `test` copy links Vite and not Prettier, writes no `node_modules/.bin`, and reads the `test` target.

## Extraction plan (third area: `./lint`, #3335)

The `lint` area also gives inputs to each project root, so it needs the same project-root rule as `format` and `test`. That is the third place. Thus the rule is extracted now, and not when `./portless` (#3336) comes. The rule is in one internal module, `src/project-roots.ts`. It is not an export of the package. It takes the `package.json` and `project.json` files and the workspace root, and it gives the root files. The glob stays with each area: `test` also reads the test files and the Vite and Vitest configs, so `test` first keeps only the `package.json` and `project.json` files, then calls the module. The targets stay with each area.

The `workspace` helper of the tests waits for the tests of `./lint`. They are its third working copy, because they need a temp workspace with Nx and `@nx/eslint` linked. The shared part then goes into `src/testing/workspace.ts`, a file of the tests that is not in the package: the temp folder, the npm workspace, Nx linked from zukhruf, the plugin entries in `nx.json`, and the `nx` runner with a clean environment. Different in each place, so it stays with each test file: the packages that it links (Prettier, Vite, `@nx/eslint` and ESLint) and the target that it reads.

After the extraction of the helper, the section "Copied with changes" is deleted, and #3361 is closed.
