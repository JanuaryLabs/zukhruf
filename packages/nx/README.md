# @zukhruf/nx

This package is the Nx part of the monorepo standard. Each workspace copied the same Nx configuration into each project. This package gives that configuration one time, in areas. Each area has its own import path, and the package has no root entry point. Lint stays in `@zukhruf/eslint`, and the Git hooks stay in `@zukhruf/git-hooks`.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Areas

| Area       | Import path          | Status                                                     |
| ---------- | -------------------- | ---------------------------------------------------------- |
| format     | `@zukhruf/nx/format` | This README                                                |
| test       | `@zukhruf/nx/test`   | Planned (#3328): one `node:test` target, copied in 5 repos |
| generators | —                    | Later, when their own count is due                         |

## format

An Nx workspace formats its files with Prettier. The `format` area is an Nx inference plugin. It gives each project of the workspace two targets: `format`, which writes the files, and `format:check`, which only reads them. You list the plugin one time in `nx.json`. You do not copy targets into each project.

## Use it

You need Nx 23 or 24 and Prettier 3. `nx`, `@nx/devkit` and `prettier` are peer dependencies.

Add the plugin to `plugins` in `nx.json`. Then add `format:check` to the `dependsOn` of `typecheck` that the workspace already has:

```jsonc
{
  "plugins": ["@zukhruf/nx/format"],
  "targetDefaults": {
    "typecheck": {
      "dependsOn": ["lint", "format:check", "..."],
    },
  },
}
```

Keep the entries that are already in the list. A `dependsOn` array replaces the array of an earlier source, and only `"..."` keeps the dependencies that `@nx/js/typescript` gives `typecheck`.

zukhruf builds this package, so it lists the plugin by path: `"plugins": ["./packages/nx/src/format/plugin.ts"]`. The package name resolves to `dist/`, and a fresh clone has no build before Nx makes the project graph.

The plugin does not change `typecheck`. That target belongs to `@nx/js/typescript`, and each workspace adds its own dependencies to it, for example `^sdk`. See [ADR 0001](./docs/adr/0001-inferred-targets-not-copied-defaults.md).

## Signature

```ts
// @zukhruf/nx/format
export const createNodes: CreateNodes;
```

The plugin takes no options. The target names and the commands are the same in each of the 7 copies that this package replaces, so no option is necessary.

## What each target runs

| Target         | Command                          | Writes? | Cached | Inputs                                                                                                                                                                                                                    |
| -------------- | -------------------------------- | ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`       | `prettier --write {projectRoot}` | yes     | no     | —                                                                                                                                                                                                                         |
| `format:check` | `prettier --check {projectRoot}` | no      | yes    | the files of the project; the root `.prettierignore` and `.editorconfig`; the config file that Prettier finds from the workspace root; `prettier` and each Prettier plugin that the config names (`externalDependencies`) |

- `format` writes. It runs only when you run it on purpose: `nx run <project>:format`. No target depends on it.
- `format:check` only reads. It fails when a file is not formatted.
- A project with no file that Prettier can format passes `format:check`. Prettier 3.9.9 passes a folder whose files are all ignored or of an unknown type. It stops with an error only for a folder with no file, and a project root always has a `project.json` or a `package.json`. Thus the command has no `--no-error-on-unmatched-pattern`.
- The plugin finds the config file with `resolveConfigFile` of Prettier, as the Prettier CLI does. It can be `.prettierrc`, `prettier.config.mjs` or the `prettier` key of the root `package.json`. That file is an input, so a change to it runs the check again. The Prettier CLI also reads `.editorconfig`, so that file is an input too. When Prettier finds no config file, no config file is an input.

To format only your own files, give their paths: `npx prettier --write <files>`. See [ADR 0002](./docs/adr/0002-a-check-never-writes.md).

## Override a project

A target in the `project.json` of a project replaces the inferred target. Nx applies the plugin first, then `targetDefaults`, then `project.json`. For example, the `infra` project of whatisgoingon formats OpenTofu files:

```json
{
  "targets": {
    "format": { "command": "tofu fmt -recursive" },
    "format:check": { "command": "tofu fmt -check -recursive" }
  }
}
```

## Leave fixtures out

The plugin gives targets only to the projects that Nx finds, by the rule and the matcher of Nx itself:

- Each folder with a `project.json` is a project.
- A folder with a `package.json` is a project only when the workspace globs of the package manager match its path, or when it has a `project.json` too. The globs are `workspaces` in the root `package.json`, `pnpm-workspace.yaml` and `lerna.json`, with their `!` negations.
- The workspace root is a project only when it has a `project.json`, or its `package.json` has an `nx` key.

Thus a fixture outside the workspace globs gets no targets, and you do not add it to `exclude`. The root files stay checked by the `Format` step of `@zukhruf/git-hooks` and by `npx prettier --check .` in CI.

A fixture inside the workspace globs is a project of Nx. Use the standard `exclude` of an Nx plugin entry to give it no format targets:

```json
{
  "plugins": [
    {
      "plugin": "@zukhruf/nx/format",
      "exclude": ["packages/connectors/manifest/src/fixtures/**"]
    }
  ]
}
```

context-compiler already does this for `@nx/eslint/plugin`. See [ADR 0003](./docs/adr/0003-which-roots-get-targets.md).

## Migrate a workspace

1. Add the plugin to `plugins` in `nx.json`.
2. Delete the `format` and `format:check` entries from `targetDefaults`.
3. Delete each opt-in: each `"format": {}` and each copied `format` or `format:check` target in a `project.json` or in `nx.targets` of a `package.json`. Keep a target only when it is an override.
4. Delete `"format"` from `lint.dependsOn` and from `typecheck.dependsOn`.
5. Add `"format:check"` to `typecheck.dependsOn`.

| Workspace        | Today                                                                                        | Opt-ins to delete                  |
| ---------------- | -------------------------------------------------------------------------------------------- | ---------------------------------- |
| zukhruf          | targetDefault `format` = `--write`; `lint` depends on `format`                               | 32 `"format": {}`                  |
| elt              | same as zukhruf                                                                              | 69                                 |
| context-compiler | same as zukhruf                                                                              | 27                                 |
| text2sql         | a full `format` target in each project; `typecheck` depends on `format`                      | 75                                 |
| factory          | targetDefaults `format` and `format:check`; `typecheck` depends on `lint` and `format:check` | 9 `nx.targets` in `package.json`   |
| whatisgoingon    | same as factory; `infra` overrides `format` with `tofu fmt`                                  | 3, and `infra` adds `format:check` |
| deepagents       | one stray `format` target in `packages/compaction`                                           | 1                                  |

## Who uses it

| Workspace        | Backlog item                    |
| ---------------- | ------------------------------- |
| zukhruf          | #3306 (phase 2, first consumer) |
| elt              | #3318                           |
| context-compiler | #3319                           |
| factory          | #3320                           |
| whatisgoingon    | #3321                           |
| text2sql         | #3322                           |
| deepagents       | #3323                           |

The umbrella item is #3317.
