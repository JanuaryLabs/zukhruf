# An inference plugin gives each project its format targets

Seven workspaces format with Prettier through Nx: zukhruf, elt, context-compiler, text2sql, factory, whatisgoingon and deepagents. Six of them define the `format` targets again, and each copy needs one opt-in for each project:

| Workspace        | Today                                                                                        | Opt-ins                          |
| ---------------- | -------------------------------------------------------------------------------------------- | -------------------------------- |
| zukhruf          | targetDefault `format` = `--write`; `lint` depends on `format`                               | 32 `"format": {}`                |
| elt              | same as zukhruf                                                                              | 69                               |
| context-compiler | same as zukhruf                                                                              | 27                               |
| text2sql         | 75 full `format` targets, one in each project; `typecheck` depends on `format`               | 75                               |
| factory          | targetDefaults `format` and `format:check`; `typecheck` depends on `lint` and `format:check` | 9 `nx.targets` in `package.json` |
| whatisgoingon    | same as factory; `infra` overrides `format` with `tofu fmt`                                  | 3, and `infra`                   |
| deepagents       | one stray `format` target in `packages/compaction`                                           | 1                                |

This is strike 7 of the Rule of Three (6 with targets), so the copies move into one package. Nx 23.2.1 (the installed source, paths under `node_modules/nx/dist/src/`) gives the facts that select the form:

- A target default never makes a target. It only fills a target that a plugin or a project file made (`project-graph/utils/project-configuration/target-defaults.js:56-70`). A target with no executor, no command and no `dependsOn` is deleted (`target-normalization.js:202-214`). That is why each project adds an opt-in such as `"format": {}`.
- Nx skips a `dependsOn` on a target that the project does not have. It gives no warning (`tasks-runner/create-task-graph.js:116-136`, `projectHasTarget` at `utils/project-graph-utils.js:11-15`). A project that forgets its opt-in thus loses the check, and no run reports it.
- A `createNodes` plugin is the only way to give a target to each project (`project-graph/plugins/public-api.d.ts:14-45`). `@nx/eslint/plugin` infers `lint` this way (`node_modules/@nx/eslint/dist/src/plugins/plugin.js:93-135`).
- `format:check` is one target name (`utils/split-target.js:53-80`).

npm has no maintained Nx inference plugin for Prettier. `@nx/prettier`, `nx-prettier`, `@nx-tools/nx-prettier`, `@nxkit/prettier` and `nx-plugin-prettier` do not exist, and `npm search "nx prettier plugin"` finds none.

The package is `@zukhruf/nx`, the Nx part of the monorepo standard. The plugin is its area `./format`, so a workspace lists `@zukhruf/nx/format`. Each area has its own import path and the package has no root entry point, as in `@zukhruf/testing` ([ADR 0002](../../../testing/docs/adr/0002-each-area-has-its-own-import-path.md)). The second area is already counted: one `node:test` target, copied in 5 repos (#3328). The generators of the private `@factory/foundation` come later, when their own count is due. Lint stays in `@zukhruf/eslint`, and the Git hooks stay in `@zukhruf/git-hooks`.

## Considered Options

- **A shared `nx.json` that each workspace `extends`.** REJECTED. `extends` is a shallow merge of the top-level keys, `{ ...base, ...workspace }`, and a base cannot extend another base (`config/nx-json.js:14-22`). A workspace with its own `targetDefaults` replaces the shared `targetDefaults` fully.
- **Copied `targetDefaults`, as today.** REJECTED. It is strike 7. Each project still needs an opt-in, and a forgotten opt-in silently drops the check.
- **A mirror in each workspace, with a ledger.** REJECTED. The Rule of Three allows a mirror at strike 2 only. A mirror at strike 7 adds copies.
- **A package with the name of the tool, `@zukhruf/prettier`, with the export `./plugin`.** REJECTED. The name fits one area only. The second area (the `node:test` target, 5 copies) and the generators are already counted, and they are Nx configuration, not Prettier.
- **The plugin also adds `format:check` to `typecheck.dependsOn`.** REJECTED. `typecheck` belongs to `@nx/js/typescript`, another plugin. Each workspace adds its own dependencies to it, for example `^sdk`. The plugin would change the target of another plugin, and a workspace's own `targetDefaults` would replace that change again.

## Consequences

A workspace lists the plugin one time in `plugins`. It deletes its `format` and `format:check` target defaults and each opt-in. It adds one line: `"format:check"` in `targetDefaults.typecheck.dependsOn`. A new project gets both targets with no opt-in, so no project can lose the check. The plugin takes no options, because the target names and the commands are the same in each copy.
