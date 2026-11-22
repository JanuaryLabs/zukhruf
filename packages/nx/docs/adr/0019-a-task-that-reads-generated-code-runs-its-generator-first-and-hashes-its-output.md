# A task that reads generated code runs its generator first and hashes its output

Status: Accepted 2026-11-22 by the owner (#5219), who picked "init, once" for where the rule lives.

Two targets write code that is not committed. `generate` writes the Prisma client of a db package (ADR 0008). `sdk` writes the sdk-it client of a backend. A task that reads this code before the target runs fails, or it passes on old code.

Before, each generator wrote the rule for the target names that it needed:

- `prisma` added `generate` and the client input to `typecheck` and `build` (#4826).
- `node-app` added `^sdk` to `build`, `dev`, `typecheck` and `test`.
- `react-app` wrote `test: { dependsOn: ["^sdk"] }` in the web project, with no `"..."`, so the `test` default did not apply to it.

The same bug came back five times, each time for one more target name: #106, #4826, #4937, #5102, #5219. In meddit (#5219, 2026-11-22), the test of the db package ran before `generate` on a fresh checkout, and stopped with `ERR_MODULE_NOT_FOUND` for `src/prisma/client.ts`.

The task graph of a workspace from the generators of 0.8.57 (Nx 24.0.6, `nx run-many --graph=stdout`) showed these gaps:

```
@acme/backend:lint runs without @acme/db:generate
@acme/backend:lint does not hash the generated code
@acme/backend:build:production does not hash the generated code
@acme/db:lint runs without @acme/db:generate
@acme/db:lint does not hash the generated code
@acme/db:test runs without @acme/db:generate
@acme/web:lint runs without @acme/backend-client:sdk
@acme/web:lint does not hash the generated code
```

Typed lint also gives a different result with no client on disk: a floating Prisma promise passes with no client (exit 0), and fails with the client (exit 1).

Nx takes one `targetDefaults` entry for a target. An entry keyed by the executor wins over an entry keyed by the target name, and Nx never merges the two (`nx/dist/src/project-graph/utils/project-configuration/target-defaults.js`, lines 278 to 333). The backend build runs `@nx/esbuild:esbuild`, so the `build` entry did not apply to it.

## Decision

`init` writes the rule one time, for every repo, in `addGeneratedSourceDefaults` of `src/generators/init/nx-json.ts`.

1. **The readers `typecheck`, `build`, `test`, `lint` and `dev` get `dependsOn` `"generate"`, `"^sdk"` and `"..."`.** Nx skips a dependency on a target that the project does not have. So a repo with no Prisma and no sdk-it client gets no extra task, and the rule is not the wiring of one kind of app (ADR 0009 decision 6). `"..."` keeps the dependencies that the plugins infer.
2. **`lint` also gets `"^build"`.** Typed lint reads the types of its dependencies, and a dependency's generated code reaches them through its build.
3. **The cached readers `typecheck`, `build` and `lint` get `inputs` `"..."` and `{ "dependentTasksOutputFiles": "**/*.ts" }`.** Nx hashes no gitignored file, so the task hashes the generated code as an output of the task that wrote it.
4. **The `@nx/esbuild:esbuild` entry gets the rule of `build`.** `node-app` writes that entry, and then calls the same function.
5. **A project target does not repeat the rule.** `react-app` keeps the env of the web `test` target (ADR 0016) and writes no `dependsOn` there.
6. **The `add-generated-source-defaults` migration of 0.8.58 brings the rule to each repo whose `nx.json` lists `@zukhruf/nx/lint`, `@zukhruf/nx/format` and `@zukhruf/nx/test`.** `init` writes the three plugins, all since its first version (e35fc327). The migration removes a web `test.dependsOn` only when it is exactly `["^sdk"]`, the value that `react-app` wrote (ADR 0017 decision 4). It logs, and does not change, a reader with its own `dependsOn` and no `"..."`, an executor entry of a reader other than `@nx/esbuild:esbuild`, and a project `generate` that depends on a reader, which makes a cycle with the rule (ADR 0017 decision 5).
7. **A test runs the real task graph of a generated workspace.** `src/generators/generated-sources.test.ts` generates a backend, a web, a db package with auth, and a ui package. It runs Nx on them, and checks that each task of a project that has a producer, or depends on one, has the producer upstream. A target that reads no generated code is in a list in the test, with its reason.

This decision supersedes the Consequences line of ADR 0008 for `generate` in `typecheck` and `build`, and decision 6 of ADR 0012 for the `generate` entries and the client input.

## Considered Options

- **A `targetDefaults` glob key such as `*`.** Not selected. Nx takes one key for a target and never merges two, so a glob entry and a name entry hide each other.
- **A plugin that adds `dependsOn` to the targets of other plugins in `createNodes`.** Not selected. A plugin does not see the targets of another plugin, and ADR 0001 rejects such a change.
- **A sync generator, or `preTasksExecution`, that runs the generators.** Not selected. That work is hidden and not cached, outside the task graph.
- **The Prisma client in Git.** Not selected. ADR 0008 keeps it gitignored, and it does not fix the sdk-it client.
- **The rule in each generator, for the target names that it needs.** Not selected. That is the shape before, and the bug came back five times with it.

## Consequences

- `lint` waits for the builds of its dependencies.
- The hash of `lint` changes when the `.d.ts` in the `dist` of a dependency changes.
- The graph test cannot see the targets of `@nx/vite/plugin` and `@nx/vitest`: their configs import packages that zukhruf does not install. The web `test` and `dev` get the rule from the defaults, as each other reader does.
- The sdk target of the client does not depend on `generate` of the db package, and its hash has no file of the db package (#5102). This ADR does not change that.
