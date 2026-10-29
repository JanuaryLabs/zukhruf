# Each project root gets both targets, and fixtures are excluded

The plugin must find the projects, tell what each target reads, and let a project replace a target. Nx and `@nx/eslint/plugin` find a project root the same way: a folder with a `project.json` or a `package.json` (`node_modules/@nx/eslint/dist/src/plugins/plugin.js:25`, `PROJECT_CONFIG_FILENAMES`). A fixture of a test can also have a `package.json`, but it is not a project. context-compiler leaves its fixtures out of `@nx/eslint/plugin` with the standard `exclude` of the plugin entry in `nx.json`.

## Considered Options

- **Roots: each folder with a `project.json` or a `package.json`.** ACCEPTED. It is the rule of Nx and `@nx/eslint/plugin`, so each project gets the targets and no other folder gets them.
- **Roots: each folder with a Prettier config.** REJECTED. The config is at the workspace root, so no project would get a target.
- **An option of the plugin with the folders to skip.** REJECTED. The `exclude` of a plugin entry already does this for each Nx plugin: `{ "plugin": "@zukhruf/prettier/plugin", "exclude": ["…/fixtures/**"] }`.
- **`format:check` fails when a project has no file that Prettier can format.** REJECTED. Prettier stops with an error when a pattern matches no file. Such a project is formatted, so it passes. The command adds `--no-error-on-unmatched-pattern` (Prettier 3.9 CLI).
- **`format:check` with no cache.** REJECTED. Its result depends only on its inputs, so Nx can cache it.

## Consequences

- `format:check` runs `prettier --check --no-error-on-unmatched-pattern {projectRoot}` with `cache: true`. Its inputs are the files of the project, the root `.prettierrc*` and `.prettierignore`, and `externalDependencies` on `prettier` and on each Prettier plugin that the config names. A change to the config, to the ignore file or to a Prettier version runs the check again.
- `format` runs `prettier --write {projectRoot}`. It has no cache, because it writes.
- Nx merges in this order: specified plugins, then target defaults, then the default plugins `nx/js`, `package.json` and `project.json` (`project-graph/utils/project-configuration-utils.js:181`, `project-graph/plugins/get-plugins.js:392-401`). A later source wins. Thus a target in `project.json` overrides the inferred target. For example, the `infra` project of whatisgoingon keeps `format` = `tofu fmt -recursive` and sets `format:check` = `tofu fmt -check -recursive`.
