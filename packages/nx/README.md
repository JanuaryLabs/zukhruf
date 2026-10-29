# @zukhruf/nx

This package is the Nx part of the monorepo standard. Each workspace copied the same Nx configuration into each project. This package gives that configuration one time, in areas. Each area has its own import path, and the package has no root entry point. Lint stays in `@zukhruf/eslint`, and the Git hooks stay in `@zukhruf/git-hooks`.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Areas

| Area             | Import path            | Status                                                                                        |
| ---------------- | ---------------------- | --------------------------------------------------------------------------------------------- |
| format           | `@zukhruf/nx/format`   | This README                                                                                   |
| test             | `@zukhruf/nx/test`     | This README                                                                                   |
| portless         | `@zukhruf/nx/portless` | Candidate (#3336): 14 projects in 3 repos                                                     |
| opentofu, prisma | —                      | Candidates (#3339): 5 places each                                                             |
| generators       | —                      | Candidates: the workspace generator of `@factory/foundation` (#3337); app kinds later (#3338) |

The lint inputs (7 copies) are #3335; their home (`@zukhruf/eslint` or an area here) is still open.

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
