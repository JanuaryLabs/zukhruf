# The plugin gives targets to the projects of Nx, by the matcher of Nx

The plugin must find the projects, tell what each target reads, and let a project replace a target. Nx 23.2.1 (the installed source, paths under `node_modules/nx/dist/src/`) gives these facts:

- Each root that a plugin returns becomes a project. Nx adds a new node for a root that it does not know (`project-graph/utils/project-configuration/project-nodes-manager.js:31-40`), and the name falls back to the name in `package.json` (`target-normalization.js:19-29`).
- No plugin hook receives the projects that Nx found. `createNodes` gets only the matched files, the options and a context with `nxJsonConfiguration` and `workspaceRoot` (`project-graph/plugins/public-api.d.ts:6-9,19,81-82,132`).
- Nx has its own rule for which folders are projects. Each folder with a `project.json` is a project (`plugins/project-json/build-nodes/project-json.js:11-21`). A folder with a `package.json` is a project only when the workspace globs of the package manager match its path, or when it has a `project.json` too. The globs are `workspaces` in the root `package.json`, `pnpm-workspace.yaml` and `lerna.json`, with their `!` negations. The workspace root is a project only when its `package.json` has an `nx` key (`plugins/package-json/create-nodes.js:32-49,186-222`).

Thus a plugin that gives targets to each folder with a `package.json` makes new projects: a fixture of a test, a generated `.sdk-it/` folder, or the workspace root. The plugin must use the rule of Nx.

## Considered Options

- **Roots: the rule of Nx, by the matcher of Nx.** ACCEPTED. The plugin calls `buildPackageJsonPatterns` and `buildPackageJsonWorkspacesMatcher` from `@nx/devkit/internal`, the functions that the `package.json` plugin of Nx uses. Each folder with a `project.json` qualifies. A folder with a `package.json` qualifies when the matcher accepts it. The plugin returns targets only, never a `name`, so the default plugins of Nx name each project. `@nx/devkit/internal` has no contract for other versions. The names were probed in nx and `@nx/devkit` 23.2.1, 24.0.1 and 24.0.2, and they are the same. The peer dependencies `nx` and `@nx/devkit` `>=23.0.0 <25.0.0` keep the plugin on these versions. If a later version changes the names, the plugin fails to load, and the error tells it.
- **Roots: each folder with a `project.json` or a `package.json`, except the workspace root.** REJECTED. A fixture with a `package.json` outside the workspace globs would become a project.
- **Roots: the matcher written again in the plugin.** REJECTED. It is a fork of the code of Nx, and it drifts from it.
- **Roots: each folder with a Prettier config.** REJECTED. The config is at the workspace root, so no project would get a target.
- **An option of the plugin with the folders to skip.** REJECTED. The `exclude` of a plugin entry already does this for each Nx plugin: `{ "plugin": "@zukhruf/nx/format", "exclude": ["…/fixtures/**"] }`.
- **`format:check` adds `--no-error-on-unmatched-pattern`, so that a project with no file that Prettier can format passes.** REJECTED. No project root makes Prettier stop with that error. A probe of Prettier 3.9.9 on 2026-10-29 gave exit code 0 for a folder whose files are all in `.prettierignore`, for a folder with only files of an unknown type, and for a folder in `.gitignore`. It gave exit code 2 only for an empty folder, and a project root always has a `project.json` or a `package.json`. A flag that no input reaches is dead code.
- **Inputs: the glob `{workspaceRoot}/.prettierrc*`.** REJECTED. It does not match `prettier.config.*` or the `prettier` key of `package.json`, and it does not match `.editorconfig`, which the Prettier CLI reads by default. A change to one of them would give a cached pass that is stale.
- **The plugin also obeys `NX_INFER_ALL_PACKAGE_JSONS`, as the `package.json` plugin of Nx does (`create-nodes.js:33-37`).** REJECTED. No repo of the 7 sets it (checked on 2026-10-29).
- **`format:check` with no cache.** REJECTED. Its result depends only on its inputs, so Nx can cache it.

## Consequences

- A fixture outside the workspace globs gets no targets, and no `exclude` is necessary. A fixture inside the workspace globs is a project of Nx. The `exclude` of the plugin entry gives it no format targets.
- The workspace root gets no targets in a monorepo. A root target would be `prettier --check .`, which checks each project again. The files at the root stay checked by the `Format` step of `@zukhruf/git-hooks` (staged files) and by `npx prettier --check .` in CI.
- `format:check` runs `prettier --check {projectRoot}` with `cache: true`. Its inputs are the files of the project, the root `.prettierignore` and `.editorconfig`, the config file that `resolveConfigFile` of Prettier finds from the workspace root, and `externalDependencies` on `prettier` and on each Prettier plugin that the config names. When `resolveConfigFile` gives `null` (`prettier/index.d.ts:661`), no config file is an input. A change to the config, to the ignore file, to `.editorconfig` or to a Prettier version runs the check again.
- `format` runs `prettier --write {projectRoot}`. It has no cache, because it writes.
- Nx merges in this order: specified plugins, then target defaults, then the default plugins `nx/js`, `package.json` and `project.json` (`project-graph/utils/project-configuration-utils.js:181`, `project-graph/plugins/get-plugins.js:392-401`). A later source wins. Thus a target in `project.json` overrides the inferred target. For example, the `infra` project of whatisgoingon keeps `format` = `tofu fmt -recursive` and sets `format:check` = `tofu fmt -check -recursive`.
