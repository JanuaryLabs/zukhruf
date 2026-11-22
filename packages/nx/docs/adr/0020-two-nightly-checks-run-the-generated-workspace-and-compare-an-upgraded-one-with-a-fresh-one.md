# Two nightly checks run the generated workspace and compare an upgraded one with a fresh one

Status: Accepted 2026-11-22 by the owner, who picked both checks and said: "we need to have them in separate workflow and should not run after each [push] … like nightly jobs".

The tests of the generators write to a virtual `Tree` and assert its text. No test ran a generated workspace as its CI runs it. In 4 days, meddit found 20 of 37 incidents of the generators while each generator test passed. #5219 is one: the test of the db package ran before `generate` on a fresh checkout.

A fix of generated output reaches an older repo only through a migration (ADR 0017). On 2026-11-22, 9 fix commits had shipped no migration. No check compared a migrated repo with a new one.

## Decision

`.github/workflows/nightly.yml` runs two jobs once a day and on `workflow_dispatch`. Each makes workspaces from the versions of `@zukhruf/nx` on npm, in a folder of `TemporaryFiles`. Both make the same shape: `create-nx-workspace` with the preset, then `node-app apps/backend`, `react-app apps/web`, `pair`, `prisma packages/db --backend apps/backend`, `auth` with `--web`, `ui-package packages/ui`, `npm install` and `nx sync` (`src/e2e/generated-workspace.ts`). dokploy is not in the shape: it writes `infra/` once and the repo owns it after (ADR 0015).

1. **`nx:e2e:smoke` runs the workspace as its CI runs it** (`src/e2e/smoke.ts`). It uses the `latest` version, or the one of `--version`. It commits the workspace through its own hooks, removes what Git ignores except `node_modules` (no generated client, no `dist`, no `.nx`), and runs `nx run-many -t lint typecheck build test --skip-nx-cache`. The tests of the db package and the backend run on a Postgres in Docker. A failed step stops the run, and the message names the step and its command.
2. **`nx:e2e:upgrade` compares a migrated workspace with a fresh one** (`src/e2e/upgrade.ts`). The base is the newest release that is older than a day, and not older than 0.8.59. 0.8.36 is the first release with every generator of the shape, and the presets of 0.8.45 to 0.8.58 do not install: they pin eslint-plugin-unicorn 79.0.0 under the ^80.0.0 peer of their @zukhruf/eslint, so npm stops with ERESOLVE (109a502b fixed it in 0.8.59; seen on 2026-11-22 with bases 0.8.52 and 0.8.58). It makes the shape with the base. Then it runs `nx migrate @zukhruf/nx@<latest>`, `npm install` and `nx migrate --run-migrations --if-exists`, and makes the shape again with `latest`. Both must run the same `nx`. Then it compares:
   - `targetDefaults`, `namedInputs` and `plugins` of `nx.json`;
   - the `nx` key of the `package.json` of each project, and its `project.json` if it has one;
   - the projects, the tasks and the edges between the tasks of `nx run-many -t <every target> --graph=stdout` (`tasks.dependencies`, by task id).

   Each difference prints its path and the two values. Any difference fails the run: a change of generated output shipped without its migration (ADR 0017).

3. **The upgrade check does not compare** commands (a repo owns a command after the generator writes it, and no migration rewrites one, ADR 0017 decision 4), versions, the file inputs that the plugins infer, source files, and the files that a generator writes once (ADR 0015).
4. **The checks are advisory.** A release does not wait for CI ([root ADR 0007](../../../../docs/adr/0007-release-does-not-wait-for-ci.md)), and no push runs them: they read npm, not the commit. A red run is a bug to fix forward.
5. **The targets are not in `ci.yml`.** Their names are not `test`, `test-network`, `lint`, `typecheck` or `build`, so no `-t` list of `ci.yml` runs them. Each has `cache: false` and `dependsOn: ["^build"]`, because the scripts import `@zukhruf/fs` from its `dist`.

## Considered Options

- **Run the checks on each push.** Not selected by the owner. A run takes many minutes, and it checks npm, which a push does not change before its release.
- **Compare all of the task graph, with the inputs and the commands.** Rejected at the review of the plan: an inferred input and a command change for intended reasons, so each run would fail.

## Consequences

- A generator change that breaks a real workspace, or that ships without its migration, shows in the next nightly run, not in the next repo that runs the generator.
- The checks read the network and Docker. A run can fail on npm or on Docker, not on the generators: read the step that failed.
- The scripts spawn `npx`, `npm` and `git` with no shell, so they run on Linux and macOS. The workflow runs on `ubuntu-latest`.
