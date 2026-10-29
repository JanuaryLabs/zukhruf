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
