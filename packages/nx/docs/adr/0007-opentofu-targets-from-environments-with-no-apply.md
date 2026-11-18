# An inference plugin gives each OpenTofu project its targets, and no apply target

Status: Proposed 2026-11-18 for the owner's review (backlog #3339).

Five projects copy the same OpenTofu targets: `infra` of whatisgoingon, and `v2-terraform`, `authx-terraform`, `desktop-terraform` and `diagnostics-terraform` of text2sql. Each one also copies `scripts/check-plan-fresh.sh`. meddit adds a sixth project. The owner put the area in scope on 2026-11-18 with these words: "targets init, format, format:check, typecheck (init -backend=false + validate, no secrets), preview, show (runs check-plan-fresh, shipped in the package), output; TF_ENCRYPTION_PASSPHRASE guard; envFile infra/.env for preview/show; deliberately no apply target".

The copies are the same in these parts: the folder `src/environments/<name>` for each root module, the commands of `init`, `format`, `format:check`, `typecheck`, `preview`, `show` and `output`, and the guard of `TF_ENCRYPTION_PASSPHRASE` that gives `TF_VAR_tf_encryption_passphrase`. They are different in these parts:

- The secrets: `DOKPLOY_API_KEY` and `HCLOUD_TOKEN` in 3 projects, `GITHUB_TOKEN` in desktop, and `AUTHX_OTLP_HEADERS` in authx.
- The environments: `production` in 4 projects; `production` and `staging` in authx, as configurations.
- The plan inputs of the freshness script: 2 scripts do not list `src/modules`, and 2 list a compose file outside the project root.
- The dependencies: in text2sql `init` depends on `typecheck`; in whatisgoingon `preview` depends on `typecheck` and runs `init` itself.
- `typecheck`: text2sql sets `TF_DATA_DIR=.terraform/validate`; whatisgoingon caches the target.

## Decision

The `opentofu` area of `@zukhruf/nx` gives the 7 targets to each project root with an environment, a folder `src/environments/<name>` with a `*.tf` file. It takes no options.

- Each environment is a configuration of `init`, `preview`, `show` and `output`. The options select `production`, else the first environment by name. `typecheck` checks each environment.
- `typecheck` reads the provider lock file and does not write it (`-lockfile=readonly`), because a check never writes ([ADR 0002](./0002-a-check-never-writes.md)). It keeps `TF_DATA_DIR=.terraform/validate`, and it is cached on the `*.tf` and `*.hcl` files and the output of `tofu version`.
- `init` depends on nothing. It is the target that writes the lock file, so it cannot wait on a check that refuses a lock file change. `preview` depends on `init`. `tofu plan` validates the configuration itself.
- The guard checks only `TF_ENCRYPTION_PASSPHRASE`, the one secret of each copy. OpenTofu reports a missing variable or provider token itself. A project gives its other secrets as `TF_VAR_<name>` in its `.env`.
- The plugin sets no `envFile`. Nx already loads `<projectRoot>/.env` and `<projectRoot>/.env.<configuration>` for each task (`nx/dist/src/tasks-runner/task-env-paths.js`). An `envFile` that does not exist stops the task (`nx/dist/src/executors/run-commands/running-tasks.js:553-558`), and CI has no `.env`.
- The freshness check is a Node script inside the package. A file of the project is a plan input when Git tracks it or does not ignore it. Thus no list of inputs can drift, and a template must be inside the project root.
- No `apply` target, as the owner said. CI applies with the reusable `tofu-apply.yml`. `plan` (the same as `preview`), `validate` (in `typecheck`) and `refresh` (one project) go.

## Considered Options

- **Options for the secrets that the guard checks.** REJECTED. The secrets are different in each project of one workspace, and an option applies to each project of the workspace. The check also predicts an error that OpenTofu gives.
- **`envFile: "<projectRoot>/.env"` on the 4 targets, as in the copies.** REJECTED. Nx loads the file already, and the option stops a task when the file does not exist.
- **The freshness script as a shell script, as in the copies.** REJECTED. `tsc` does not copy a `.sh` file into `dist`, and the package ships `dist` only. A Node script ships with the build and runs where Node runs.
- **A list of plan inputs, as in the copies.** REJECTED. The 5 lists drifted. Git already knows the files of the project.
- **`init` depends on `typecheck`, as in text2sql.** REJECTED. With a read-only lock file, a new provider stops `typecheck`, and then `init` never runs to record it.

## Consequences

A workspace lists `@zukhruf/nx/opentofu` after `@zukhruf/nx/format`, deletes the copied targets and the script, and moves its other secrets to `TF_VAR_<name>` in `.env`. The compose files of v2 and authx move into their project roots. After a provider change, a person runs `init` before `typecheck` passes, and commits the lock file. The freshness check needs Git.
