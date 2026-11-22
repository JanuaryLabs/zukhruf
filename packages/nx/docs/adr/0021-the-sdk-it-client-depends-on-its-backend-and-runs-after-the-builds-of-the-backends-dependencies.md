# The sdk-it client depends on its backend and runs after the builds of the backend's dependencies

Status: Accepted 2026-11-22 by the owner (#5102), who picked `implicitDependencies` with `^build-deps`. The first pick was a `dependsOn` that names the backend's `build-deps`. The owner picked again after the review showed that `nx affected` does not reach the client.

`sdk-it generate` reads the types of a backend. Through them it reads the generated code of the backend's dependencies, such as the Prisma client of a db package (ADR 0008). The client imports neither the backend nor the db package, so the project graph had no edge from the client to them.

A workspace from the generators of 0.8.59 (Nx 24.0.6) showed three gaps:

- `@acme/backend-client:sdk` had no task upstream. In meddit CI, sdk-it ran beside `generate` and wrote a client typed `any` (#5102).
- The `sdk` hash had no file of the db package. Its inputs were `{ "projects": ["<backend>"], "input": "production" }`, the lockfile and its own `package.json`. A schema change replayed an old client from the cache.
- `nx show projects --affected --files=apps/backend/src/server.ts`, and the same for `packages/db/schema.prisma`, listed the backend and the db package. It did not list the client or the web.

## Decision

1. **The client stub has `implicitDependencies: ["<backend>"]`.** The edge puts the client and its consumers in `nx affected` when a file of the backend or of its dependencies changes.
2. **The `sdk` target has `dependsOn: ["^build-deps"]`.** It runs `build-deps` of the backend.
3. **The backend has `"build-deps": { "dependsOn": ["^build"] }`.** Nx makes a target with no command a no-op. It runs the builds of the backend's dependencies, and the rule of ADR 0019 runs `generate` before each build.
4. **The `sdk` inputs are `^production`, `{ "dependentTasksOutputFiles": "**/*.ts", "transitive": true }`, the root lockfile and the client's `package.json`.** `^production` replaces the named input of the backend. The output input hashes the generated `.ts` of the tasks upstream, the Prisma client too.
5. **The edge brings no npm package into a consumer's manifest.** An implicit dependency orders the builds and is never an import. `manifest/dependency-checks` of `@zukhruf/eslint` already leaves out the npm packages that only such an edge reaches (#4573, ADR 0005 of `@zukhruf/eslint`). The TypeScript sync of Nx skips implicit edges too.
6. **The `add-sdk-build-edges` migration of 0.8.60 brings the edge to each node-app.** Each backend gets `build-deps`. Its client gets the implicit dependency and the new `sdk` only when the `sdk` target is the one that `node-app` wrote. It logs any other `sdk` target, with the values to write, and does not change it (ADR 0017 decision 5).
7. **The graph test checks the three gaps.** `src/generators/generated-sources.test.ts` checks that `@acme/db:generate` is upstream of the `sdk` task, that the plan of the `sdk` task holds the generated client of the db package, and that `nx show projects --affected` lists the client and the web for a backend file and for the schema.

## Considered Options

- **A `dependsOn` that names the backend's `build-deps`.** Not selected. It orders the task and fixes the hash, but `nx affected` follows the project graph, and a `dependsOn` adds no edge to it.
- **A `dependsOn` that names the db package's `generate`.** Not selected. The client then knows which db package the backend uses. Meddit wrote this by hand, and the migration logs it.
- **No implicit edge, because Nx's dependency check follows it.** Not selected. `@zukhruf/eslint` already removes what such an edge reaches, so there is no leak.

## Consequences

- `sdk` waits for the builds of the backend's dependencies.
- The hash of `sdk` changes when a file of the backend's dependencies or their generated code changes.
- `nx affected` runs the client and the web for each change of the backend or of a package it depends on.
