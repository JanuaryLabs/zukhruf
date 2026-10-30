# @zukhruf/nx

This package is the Nx part of the monorepo standard. Each workspace copied the same Nx configuration into each project. This package gives that configuration one time, in areas. Each area has its own import path, and the package has no root entry point. The lint rules stay in `@zukhruf/eslint`, and the Git hooks stay in `@zukhruf/git-hooks`.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Areas

| Area             | Import path            | Status                                                                                        |
| ---------------- | ---------------------- | --------------------------------------------------------------------------------------------- |
| format           | `@zukhruf/nx/format`   | This README                                                                                   |
| test             | `@zukhruf/nx/test`     | This README                                                                                   |
| lint             | `@zukhruf/nx/lint`     | This README                                                                                   |
| portless         | `@zukhruf/nx/portless` | Candidate (#3336): 14 projects in 3 repos                                                     |
| opentofu, prisma | —                      | Candidates (#3339): 5 places each                                                             |
| generators       | —                      | Candidates: the workspace generator of `@factory/foundation` (#3337); app kinds later (#3338) |

The lint rules stay in `@zukhruf/eslint`. The `lint` area gives only the inputs of the `lint` target (#3335).

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

## test

> Status: shipped (#3328).

Seven workspaces run their tests with `node --test` through Nx. Each one copies the `test` target, and the flags drifted. The `test` area is an Nx inference plugin. It gives the `test` target to each project that has `node:test` files. You list the plugin one time in `nx.json`. You do not copy the target, and you do not tag the project.

### Use the test area

You need Nx 23.2.1 or later. The peer range of `nx` and `@nx/devkit` becomes `>=23.2.1 <25`. See [Prerequisites of the test area](#prerequisites-of-the-test-area).

Add the plugin to `plugins` in `nx.json`. The options are optional. They apply to each project of the workspace:

```json
{
  "plugins": [
    "@zukhruf/nx/format",
    {
      "plugin": "@zukhruf/nx/test",
      "options": { "timeout": 60000, "flags": [] }
    }
  ]
}
```

zukhruf builds this package, so it lists the plugin by path, as it does for `format`: `"./packages/nx/src/test/plugin.ts"`.

### Signature of the test area

```ts
// @zukhruf/nx/test
export const createNodes: CreateNodes<{
  timeout?: number;
  flags?: string[];
}>;
```

Unlike `format`, this plugin takes options. The repos use different flags, so each difference is a parameter:

| Option    | Default | Effect                                                                                                                           |
| --------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `timeout` | `60000` | the value of `--test-timeout`, in milliseconds                                                                                   |
| `flags`   | `[]`    | more Node flags for each project of the workspace, for example `["--test-force-exit"]` or `["--experimental-test-module-mocks"]` |

### Which projects get the test target

The plugin finds the test files. It does not read tags or imports. A project root gets the `test` target when all of these are true:

- The root owns at least one test file: `*.test.ts`, `*.test.mts`, `*.test.cts`, `*.test.js` or `*.test.mjs`. A file belongs to its nearest project root.
- The root has no `vitest.config.*`.
- The root has no `vite.config.*` with a `test` key. `@nx/vitest` uses the same condition (`@nx/vitest/dist/src/plugins/plugin.js:132`).
- The root is not the workspace root `.`.

The project roots are the same as for `format` (see [ADR 0003](./docs/adr/0003-which-roots-get-targets.md)). The plugin adds `**/*.test.{ts,mts,cts,js,mjs}` and `**/{vite,vitest}.config.{js,ts,mjs,mts,cjs,cts}` to the files that it reads. Thus Nx runs the plugin again when a test file or a Vite config changes. The plugin loads Vite from the workspace only for a root with a `vite.config.*`. Nx does not give the plugin the paths in `.gitignore`, so the plugin does not see `dist`.

A project with Vitest files and `node:test` files gets no `test` target from this plugin. `@nx/vitest` gives it its target, as today.

The 2026-10-29 audit of the 7 repos measured the effect. The rule matches each `node:test` target in use. 11 targets that test nothing go: in context-compiler the connectors `call-history`, `contacts`, `messages`, `slack` and `teams`; in text2sql `backend/inputs`, `harness/runs`, `toolkit/dashboards`, `reports`, `rpc` and `threads`. In text2sql, `.agents` and `.claude` get a target, because they own test files. The `test:node` tag is not necessary. A repo can delete it. See [ADR 0004](./docs/adr/0004-node-test-target-from-test-files.md).

### What the test target runs

| Part        | Value                                                                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command     | `node --test --no-warnings --test-timeout=<timeout> <flags> --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=test-results.xml {args}` |
| `cwd`       | `{projectRoot}`                                                                                                                                                                                |
| `args`      | the test selection (see below)                                                                                                                                                                 |
| `outputs`   | `["{projectRoot}/test-results.xml"]`                                                                                                                                                           |
| `cache`     | `false`                                                                                                                                                                                        |
| `dependsOn` | `["^build"]`                                                                                                                                                                                   |

- `--no-warnings`: 5 of the 7 repos use it.
- `--test-timeout`: zukhruf and deepagents use 60 s, so the default is 60 s. The other repos have no time limit, and that is drift.
- Two reporters: `spec` to the terminal and `junit` to `test-results.xml`. zukhruf, deepagents and text2sql use both.
- `^build`: a test imports the built output of the packages that the project depends on. factory, whatisgoingon and text2sql test from the source, so `^build` is sufficient for them. A repo whose tests also need the project's own `build` adds it (see [Prerequisites of the test area](#prerequisites-of-the-test-area)).
- No cache: no repo caches a `node:test` run today.

The base command has no `--test-force-exit` and no `--experimental-test-module-mocks`. Only Docker tests and tests with open handles need `--test-force-exit`. Only deepagents and the text2sql electron app use module mocks. A repo adds these flags with the `flags` option. One project adds them in its own `args` (see [Override the test target of a project](#override-the-test-target-of-a-project)).

The test selection is a list of globs:

- one glob for each top-level folder that has test files, for example `"src/**/*.test.ts" "eval/**/*.test.ts"`,
- one glob with no `**` for the test files directly in the project root, for example `"*.test.ts"`, only when such files exist.

Thus a file outside these globs does not run, for example a build output or a `test/helpers/*` file with no test file next to it. Node's own default pattern, `**/{test,test/**/*,test-*,*[._-]test}.{js,mjs,cjs,ts,mts,cts}`, matches too much: `dist/spec/test/*`, `test/helpers/*` and `*.e2e.test.ts`.

### Run one file or one test

`--args` replaces the test selection. Use it to run one file:

```sh
nx run mutex:test --args="src/mutex/mutex.test.ts"
```

A Node flag on the CLI keeps the test selection. Use it to run the tests with a name:

```sh
nx run mutex:test --test-name-pattern=login
```

The command ends with `{args}`. For a command with `{args}`, Nx puts the CLI flags and the positional words first, then `args` (`nx/dist/src/executors/run-commands/run-commands.impl.js:136-142`). Thus `--test-name-pattern=login` comes before the globs, and Node reads it as a flag.

Without `{args}`, the order is different. Nx puts a CLI flag after `args` (`run-commands.impl.js:117-119` and `145-162`): only an unknown option that is not on the CLI comes before `args`. Then `nx run mutex:test --test-name-pattern=login` puts the flag after the globs, and Node reads it as a file name.

A positional file does not replace the selection. In `nx run mutex:test src/mutex/mutex.test.ts`, Nx adds the file before the selection, and all the tests run. Use `--args`.

A probe on Nx 23.2.1 (2026-10-29) showed this, with `args` `DEFAULT` and a command that prints its arguments:

| CLI                                  | With `{args}`                       | Without `{args}`                    |
| ------------------------------------ | ----------------------------------- | ----------------------------------- |
| `--args=X`                           | `X`                                 | `X`                                 |
| `--test-name-pattern=login`          | `--test-name-pattern=login DEFAULT` | `DEFAULT --test-name-pattern=login` |
| `pos.test.ts`                        | `pos.test.ts DEFAULT`               | `DEFAULT pos.test.ts`               |
| `--args=X --test-name-pattern=login` | `--test-name-pattern=login X`       | —                                   |

The selection is in `args` and not in the command, because a flag after a glob does not work. `node --test "x.test.ts" --test-timeout=1` reads the flag as a file name. It stops with exit code 1: `Could not find 'x.test.ts, --test-timeout=1'`. zukhruf has `"src/**/*.test.ts"` at the end of its command today, so a zukhruf run cannot narrow. Also, a glob that matches no file gives exit code 0. Thus a wrong narrowing passes with no test.

### Docker tests

A project with the tag `test:docker` starts Docker containers in its tests. zukhruf and deepagents already use this tag. The plugin adds three items to the `test` target of such a project:

- `--test-global-setup=<path>`. The global setup of `@zukhruf/testing` makes one run of all the test processes, and it removes what a killed run leaves.
- `--test-force-exit`. The teardown of the global setup is synchronous on purpose, so it runs also under `--test-force-exit` (`packages/testing/src/scripts/docker-global-setup.ts:99-104`).
- `cache: false`. The result depends on the engine, not only on the files.

`cache: false` is the default, not a guarantee. The base target has no cache too. `targetDefaults` and the project files come after the plugin, so a repo can set `cache: true` on both.

The plugin selects the path in this order:

1. The project's own `src/testing/docker-global-setup.ts`, if it exists. mutex has one: it starts the shared servers before the run. `@zukhruf/testing` has one: its tests use its own source.
2. Else, `@zukhruf/testing/docker-global-setup`, resolved from the project root with the default conditions. This gives `dist/scripts/docker-global-setup.js`. The plugin writes the path relative to the `cwd` of the target.
3. If the plugin cannot resolve the package, it stops with an error. It does not run the tests with no global setup.

The value must be a path. Node resolves it with `path.resolve(cwd, value)`, so a package name does not work. That is why 5 repos keep a file that only re-exports the global setup. Each repo deletes this file when it migrates. The global setup runs one time for each `node --test` process.

The plugin does not select the Docker engine. It never sets or deletes `DOCKER_CONTEXT` or `DOCKER_HOST`, and it never calls the Docker CLI. The user, CI or the repo selects the engine. See [ADR 0005](./docs/adr/0005-docker-tests-get-the-global-setup.md).

On an SSH engine, a repo adds `--test-concurrency=1` with `flags`, or `"parallelism": false` in `targetDefaults`. The plugin does not add them.

### Override the test target of a project

Nx applies the plugin first, then `targetDefaults`, then `project.json` and `package.json`. A later source wins.

A flag for each project of the workspace goes into the `flags` option. A flag for one project goes into the `args` of that project, before its own selection. `args` comes after the command, and a flag must come before a glob. For example, the text2sql backends have a time limit of 120 s:

```json
{
  "targets": {
    "test": {
      "options": { "args": "--test-timeout=120000 \"src/**/*.test.ts\"" }
    }
  }
}
```

Node uses the last `--test-timeout`, so the value in `args` wins. A probe on Node 26.10.0 showed this on 2026-10-29: `--test-timeout=50 --test-timeout=60000` passed a test of 300 ms, and the reverse order failed it.

text2sql leaves the integration tests out of `test` in the same way: `"args": "\"src/**/!(*.integration).test.ts\""`. Other flags for one project: a time limit of 10 s, `--experimental-test-module-mocks`, `--test-force-exit`, `--env-file`.

Do not override the `command`. A command in a project file is a new copy of the target.

These rules stay in their repo, because they are of a different kind:

- the script of deepagents that selects the Docker context,
- the tests of elt and context-compiler that run from the workspace root,
- the list of e2e files of the context-compiler desktop app.

A `scripts.test` in a `package.json` replaces the inferred target. Nx runs it with `nx:run-script`. The 4 demo projects of deepagents keep their scripts.

### Prerequisites of the test area

- Nx 23.2.1 or later. In Nx 23.2.1, a target default with its own `command` replaces the command of a plugin (`nx/dist/src/project-graph/utils/project-configuration/target-defaults.js:201-229`). Nx 23.1.0 does not do this. text2sql uses 23.1.0 today.
- Delete the `command` of `targetDefaults.test` in `nx.json`. If you keep it, it replaces the command of the plugin.
- Write each extra dependency with `"..."`, so that `^build` stays. For example, factory writes `["...", "^sdk"]`.
- If the tests of a project use its own built output, add `build`: `targetDefaults.test.dependsOn: ["...", "build"]`. zukhruf, deepagents, elt and context-compiler need this. For example, the tests of `@zukhruf/nx` resolve `@zukhruf/nx/format` to `dist`. Nx skips a dependency on a target that the project does not have, so this is safe for a project with no `build`.

### Migrate a workspace to the test area

1. Update `nx` and `@nx/devkit` to 23.2.1 or later.
2. Add `@zukhruf/nx/test` to `plugins` in `nx.json`. Set `timeout` and `flags` if the repo needs other values.
3. Delete the `command` of `targetDefaults.test`, and its tag filters. Write each extra dependency with `"..."`.
4. Delete each `test` target in a `project.json` or `package.json` that the plugin now gives. Move the flags of one project into its `args`.
5. Add the tag `test:docker` to each project with Docker tests.
6. Delete the file that only re-exports `@zukhruf/testing/docker-global-setup`. Keep a file that does more, for example the mutex file.
7. Delete the `test:node` tags.
8. Compare `nx show projects --withTarget test` before and after. The differences must be the ones in the table.

| Workspace        | Today                                                                                                                                             | Changes                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| zukhruf          | `targetDefaults.test` with filters `tag:test:node` and `tag:test:docker`; `dependsOn` `["build", "^build"]`; `--test-force-exit` for each project | 30 tagged projects; 2 Docker projects (mutex, testing) keep their own global setup; `dependsOn` `["...", "build"]`; `flags` `["--test-force-exit"]` if it keeps force-exit for each project                                                                                                                    |
| factory          | 2 targets: `api` with Docker arguments; `foundation` with its tests in `tests/`                                                                   | delete `apps/factory/api/src/testing/docker-global-setup.ts`; `dependsOn` `["...", "^sdk"]`                                                                                                                                                                                                                    |
| whatisgoingon    | 1 target                                                                                                                                          | 1                                                                                                                                                                                                                                                                                                              |
| deepagents       | 11 tagged projects, 3 Docker projects, 4 demo scripts                                                                                             | delete `tools/src/docker-global-setup.ts`; `dependsOn` `["...", "build"]`; module mocks in `flags` or in the `args` of a project; the 4 demo scripts and the Docker context script stay                                                                                                                        |
| elt              | 55 commands in the projects, 8 with the global setup                                                                                              | delete `docker-global-setup.ts`; `dependsOn` `["...", "build"]`; the runs from the workspace root stay as overrides                                                                                                                                                                                            |
| context-compiler | 17 targets; the `plugin` project has a no-op `test` that depends on `server:test`                                                                 | 5 connector targets that test nothing go; `dependsOn` `["...", "build"]`; the desktop e2e files stay as an override; if `plugin` owns no test file, the plugin gives it nothing and its own `test` in `project.json` stays                                                                                     |
| text2sql         | about 24 commands in the projects, and 13 projects on the shared default; Nx 23.1.0                                                               | update Nx; delete `packages/adapters/src/testing/docker-global-setup.ts` and `apps/desktop/backend/src/testing/docker-global-setup.ts`; 6 targets that test nothing go; `.agents` and `.claude` get a target; the backends set `--test-timeout=120000` in `args`; the daemon keeps `["image"]` or uses `"..."` |

### Who uses the test area

| Workspace        | Backlog item                                |
| ---------------- | ------------------------------------------- |
| zukhruf          | uses it: `nx.json` lists the plugin by path |
| factory          | #3363                                       |
| whatisgoingon    | #3364                                       |
| deepagents       | #3365                                       |
| elt              | #3366                                       |
| context-compiler | #3367                                       |
| text2sql         | #3368                                       |

The umbrella item is #3328.

## lint

Nx caches the `lint` target. A cached result is correct only when each file and each package that ESLint loads is an input. Seven workspaces write the packages by hand in `targetDefaults.lint.inputs`, and the lists drift: 5 to 15 packages. When a package is not in the list, an update of that package does not change the hash. Nx then replays a cached pass, and the new rules do not run.

The `lint` area is an Nx inference plugin. It adds inputs to the `lint` target that `@nx/eslint/plugin` gives. It does not make a `lint` target, and it does not change the command. It reads the packages from `@zukhruf/eslint`, so no workspace writes a list.

### Use the lint area

You need Nx 23.2.1 or later, `@nx/eslint` and `@zukhruf/eslint`. Add the plugin to `plugins` in `nx.json`, after `@nx/eslint/plugin`:

```json
{
  "plugins": [
    { "plugin": "@nx/eslint/plugin", "options": { "targetName": "lint" } },
    "@zukhruf/nx/lint"
  ]
}
```

The order is necessary. Nx merges the plugins in the order of the list, and a later plugin wins. The plugin writes `"..."` first in its `inputs`, so the inputs of `@nx/eslint/plugin` stay. If the plugin comes first, `@nx/eslint/plugin` replaces its inputs, and no run reports it. Thus the plugin stops with an error when an `@nx/eslint/plugin` entry is not before it in `plugins`. A workspace can have more than one `@nx/eslint/plugin` entry, for example with `include` and `exclude`. Then the plugin must come after each of them.

The plugin finds its own entry in `plugins` as Nx finds a plugin: it resolves each entry from the workspace root with `require.resolve` (`nx/dist/src/project-graph/plugins/in-process-loader.js:42,51`). An entry that resolves to the file of the plugin is its own entry.

zukhruf builds this package, so it lists the plugin by path, as it does for `format` and `test`: `"./packages/nx/src/lint/plugin.ts"`. A workspace that builds this package must list it by path. Nx resolves a package of the workspace by name with the `customConditions` of the root tsconfig (`nx/dist/src/project-graph/plugins/resolve-plugin.js:37-41,87-95`), and `require.resolve` does not. Then the two paths are different, and the plugin stops with the order error.

### Signature of the lint area

```ts
// @zukhruf/nx/lint
export const createNodes: CreateNodes;
```

The plugin takes no options. A workspace adds its own lint packages in `targetDefaults` (see [Add a lint package of the workspace](#add-a-lint-package-of-the-workspace)).

The name of the target is the `targetName` of each `@nx/eslint/plugin` entry. An entry with no `targetName` gives `lint`, as `@nx/eslint/plugin` does (`@nx/eslint/dist/src/plugins/plugin.js:325`).

### What the lint area adds

`@nx/eslint/plugin` already gives these inputs to `lint` (`@nx/eslint/dist/src/plugins/plugin.js:284-297`):

- `default` and `^default`,
- the root ESLint config and the ESLint config of the project,
- the `.eslintignore` of the project, when it exists,
- the tsconfig files outside the project root that the tsconfig of the project extends,
- `{workspaceRoot}/tools/eslint-rules/**/*`,
- `externalDependencies` on `eslint`.

The plugin keeps them, and it adds the packages of `@zukhruf/eslint`. It finds `@zukhruf/eslint` from the workspace root, in one of two forms:

| Form of `@zukhruf/eslint`                                           | Inputs that the plugin adds                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| an installed package in `node_modules` (each workspace but zukhruf) | `{ "externalDependencies": ["@zukhruf/eslint"] }`                                                                   |
| a package of the workspace (zukhruf)                                | the files of its `src` folder, and `externalDependencies` on each name in its `dependencies` and `peerDependencies` |

One entry is sufficient for an installed package. Nx makes a node for each package of the lockfile, with an edge for each name in `dependencies`, `peerDependencies` and `optionalDependencies` (`nx/dist/src/plugins/js/lock-file/npm-parser.js:155-170`). An input on `@zukhruf/eslint` hashes all the packages that these edges reach. Thus the hash includes each peer of `@zukhruf/eslint`, each dependency, and the packages that they load in turn. A peer that is not installed has no node, so it is not an input, and it gives no error. The hash of a package is its `integrity` in the lockfile, or its version (`npm-parser.js:103`).

A package of the workspace has no node in the lockfile. An `externalDependencies` entry with no node stops the run with an error: `The externalDependency '<name>' for '<project>:lint' could not be found`. Thus, for zukhruf, the plugin reads the names from the `package.json` of `@zukhruf/eslint`.

The plugin stops with an error in these cases. It does not give `lint` without the inputs:

- An `@nx/eslint/plugin` entry is not before the plugin in `plugins`, or `plugins` has no `@nx/eslint/plugin` entry.
- `@zukhruf/eslint` does not resolve from the workspace root.
- `@zukhruf/eslint` resolves to a folder outside the workspace and outside `node_modules`, for example after `npm link`. Nx has no node in the lockfile for such a package, so no input can hash it.

The plugin gives inputs to each project root (see [ADR 0003](./docs/adr/0003-which-roots-get-targets.md)). A project with no `lint` from `@nx/eslint/plugin` gets no `lint`: Nx deletes a target with no executor, no command and no `dependsOn` (`nx/dist/src/project-graph/utils/project-configuration/target-normalization.js:202-214`).

A probe on Nx 23.2.1 (2026-10-30) showed this:

| Order of `plugins`                    | `inputs` of the plugin                   | `lint` of the project                                                           |
| ------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------- |
| `@nx/eslint/plugin`, then this plugin | `["...", { externalDependencies }]`      | `eslint .` with the inputs of `@nx/eslint/plugin` and the new inputs            |
| `@nx/eslint/plugin`, then this plugin | `[{ externalDependencies }]`, no `"..."` | `eslint .` with only the new inputs                                             |
| this plugin, then `@nx/eslint/plugin` | with or without `"..."`                  | `eslint .` with only the inputs of `@nx/eslint/plugin`; the new inputs are lost |

In the same probe, `@zukhruf/eslint` had the peer `typescript-eslint`. A change of the version of `typescript-eslint` in the lockfile gave a new hash, and `lint` ran again. A change of the `integrity` of `globals`, a dependency of `@zukhruf/eslint`, did the same. Without the input, the same change gave a cached pass. See [ADR 0006](./docs/adr/0006-lint-inputs-from-the-eslint-package.md).

### Add a lint package of the workspace

Some configs load a package that is not in the edges of `@zukhruf/eslint`. Add it in `targetDefaults` with `"..."` first:

```json
{
  "targetDefaults": {
    "lint": {
      "inputs": [
        "...",
        {
          "externalDependencies": ["eslint-plugin-no-barrel-files"]
        }
      ]
    }
  }
}
```

`targetDefaults` comes after the plugins. Without `"..."`, its `inputs` replace the inputs of both plugins. A probe on Nx 23.2.1 (2026-10-30) showed both results.

The package above is an example from the audit: 3 project configs of text2sql load `eslint-plugin-no-barrel-files`.

`nx.configs['flat/react']` of `@nx/eslint-plugin` loads 4 packages, but `@nx/eslint-plugin` does not declare them (`@nx/eslint-plugin/dist/src/flat-configs/react-base.js:4` and `react-jsx.js:4-6`): `eslint-plugin-import`, `eslint-plugin-jsx-a11y`, `eslint-plugin-react` and `eslint-plugin-react-hooks`. Do not add them in `targetDefaults`. Import `@zukhruf/eslint/react` in each React project config. It gives `nx.configs['flat/react']`, and `@zukhruf/eslint` declares the 4 packages as optional peers. Thus they are lockfile edges of `@zukhruf/eslint`, and the plugin hashes them.

A local file that the root ESLint config imports is also an input of the workspace, for example `{workspaceRoot}/island.eslint.config.mjs`. Add it in the same way.

### Prerequisites of the lint area

- Nx 23.2.1 or later. The peer range of the package is `>=23.2.1 <25`.
- `@zukhruf/eslint` in the workspace. elt and context-compiler do not use it today: they have their own `personal.eslint.config.mjs`. They move to `@zukhruf/eslint` first.
- Delete the hand list in `targetDefaults.lint.inputs`. `targetDefaults` comes after the plugins, so a list without `"..."` replaces the inputs of the plugin.
- Keep the other keys of `targetDefaults.lint`, for example the `options.command`, `env` and `parallelism` of deepagents.
- `targetDefaults.lint` must not have `dependsOn` or a top-level `command`. Nx deletes the `lint` of the plugin on a project with no ESLint only when the target has no `executor`, no `command` and no `dependsOn` (`nx/dist/src/project-graph/utils/project-configuration/target-normalization.js:202-214`). With `dependsOn`, each project with no ESLint gets an `nx:noop` `lint` that runs the dependencies. With a top-level `command`, each such project gets a `lint` that runs the command. `options.command` is safe: Nx does not read it as a top-level `command` (`target-merging.js:15-33`). elt and context-compiler have `dependsOn: ["format"]` today, so they delete it first.
- A `lint` target in a `project.json` with its own `executor` or `command` replaces the inputs of both plugins (`target-merging.js:443-457`). Delete such a target, or write its `inputs` with `"..."`.

### Migrate a workspace to the lint area

1. Add `@zukhruf/nx/lint` to `plugins`, after `@nx/eslint/plugin`.
2. Delete `targetDefaults.lint.inputs`, and delete `targetDefaults.lint.dependsOn` and a top-level `targetDefaults.lint.command` (see [Prerequisites of the lint area](#prerequisites-of-the-lint-area)).
3. In each React project config, import `@zukhruf/eslint/react` instead of `nx.configs['flat/react']`.
4. If the configs load a package that is not in the edges of `@zukhruf/eslint`, add `["...", { "externalDependencies": [...] }]` (see [Add a lint package of the workspace](#add-a-lint-package-of-the-workspace)).
5. Compare `nx show target inputs <project>:lint --json` before and after, for one project of each kind. Each package of the old list must be in `external`.

| Workspace        | Packages in the hand list today | After the migration                                                                                                                                                                                                   |
| ---------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| zukhruf          | 13, and `packages/eslint/src`   | no list; `@zukhruf/eslint` is a package of the workspace                                                                                                                                                              |
| factory          | 14                              | the 5 React project configs import `@zukhruf/eslint/react`, not `nx.configs['flat/react']`; `tools/eslint-rules` goes from the list, because `@nx/eslint/plugin` gives it                                             |
| whatisgoingon    | 15                              | the same as factory, with 2 React project configs                                                                                                                                                                     |
| deepagents       | 9                               | the 4 React project configs import `@zukhruf/eslint/react`; `tsconfig.base.json` goes when the tsconfig chain gives it; `options.command`, `env` and `parallelism` stay                                               |
| text2sql         | 7                               | the 21 React project configs import `@zukhruf/eslint/react`; `eslint-plugin-no-barrel-files` (3 project configs load it) goes in `targetDefaults` with `"..."`; Nx updates from 23.1.0 first; `options.command` stays |
| elt              | 7                               | waits: moves to `@zukhruf/eslint` first                                                                                                                                                                               |
| context-compiler | 5                               | waits: moves to `@zukhruf/eslint` first                                                                                                                                                                               |

The lockfile measured the edges on 2026-10-30. For factory, whatisgoingon, deepagents and text2sql, each package of the hand list is in the edges of `@zukhruf/eslint`, except the 4 packages of `flat/react`. `@zukhruf/eslint/react` adds them as optional peers. An optional peer is an edge only when the workspace installs it, so the root `devDependencies` of the 4 packages stay in these 4 workspaces.

### Who uses the lint area

No workspace uses it yet. The umbrella item is #3335.
