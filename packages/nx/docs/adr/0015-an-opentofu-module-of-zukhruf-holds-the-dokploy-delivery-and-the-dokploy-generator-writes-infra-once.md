# An OpenTofu module of zukhruf holds the Dokploy delivery, and the dokploy generator writes infra once

Status: Proposed 2026-11-19 (backlog #4733, step 1), for review before any code. It supersedes the ownership rule of [ADR 0011](./0011-the-dokploy-generator-writes-the-gitops-delivery-of-a-node-app.md) decision 17 for the files of `infra/`. The other decisions of ADR 0011 stay.

ADR 0011 decision 17 says that the dokploy generator owns every file of `infra/` and writes them again on each run. A host therefore cannot add a key to the env of `dokploy_compose` in `main.tf` or to the compose by hand: the next run deletes it. Two places need that now. The auth generator must give the backend `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` ([ADR 0014](./0014-the-auth-generator-adds-better-auth-to-a-backend-and-its-db-package.md), part B, #4719). meddit's mailer needs `RESEND_API_KEY` and `MAIL_FROM`, and meddit's backend does not boot without them since 030176e, so meddit's deploy is blocked (#4725).

The owner approved the direction on 2026-11-19 ("agree", #4733): do for infra what #3344 did for the workflows. The shared delivery logic moves into an OpenTofu module of zukhruf that a host calls with a git source and a ref, as the workflows call zukhruf's actions. The generator writes the host's `infra/` files once, and the repo owns them afterwards. A host passes its needs as module inputs.

Facts read on 2026-11-19:

- The hosts are meddit (`infra/`, Postgres and a GHCR registry) and whatisgoingon (`infra/`, neither, a DNS record, and an `imports.tf`). Both have one encrypted state in Git at `infra/src/terraform.tfstate`. Neither state was read.
- `tofu-apply.yml` checks out the caller, installs OpenTofu, and runs `tofu init`, `plan` and `apply`. It sets up no Node and runs no `npm ci`, so `node_modules` does not exist when `tofu init` runs.
- The `typecheck` target of `@zukhruf/nx/opentofu` runs `tofu init -backend=false -lockfile=readonly` and is cached on the `*.tf` and `*.hcl` files of the project and the output of `tofu version` (ADR 0007).
- OpenTofu 1.12.3 (the version on the hosts' `required_version = ">= 1.12.3"`) fetches `git::https://github.com/JanuaryLabs/zukhruf.git//packages/nx?ref=release/0.8.35&depth=1` in 6 seconds; the checkout is 79 MB. A ref with a slash works. `.terraform.lock.hcl` records providers only, never a module.
- The release workflow of zukhruf tags each release `release/<version>` (`nx.json` `releaseTag.pattern`), and pushes the tag. 121 tags exist; the newest is `release/0.8.35`.
- A probe on OpenTofu 1.12.3 with `terraform_data` and `random_string`:
  - A `moved` block from a root resource to `module.<name>.<type>.<name>[0]`, with `prevent_destroy` inside the module, plans "0 to add, 0 to change, 0 to destroy". `tofu plan -detailed-exitcode` still exits 2 for a plan that only moves.
  - An `import` block whose `to` is the old root address fails with "Configuration for import target does not exist". Rewritten to the address in the module, it is skipped, even with a wrong ID, because the state already has the address.
  - `count = var.registry == null ? 0 : 1` works when an attribute of the object is sensitive. A variable validation may read another variable.
  - `tofu test` with `mock_provider "dokploy"` runs on the real provider schema. `mock_resource` defaults are known in a `command = plan` run, so a plan can assert `compose_id`. An `apply` run passes, but its cleanup cannot destroy resources with `prevent_destroy`: it writes `errored_test.tfstate` and still exits 0.
  - `tofu show -json` of a plan holds sensitive values in plain text, marked in `after_sensitive`.
  - `tofu fmt -check -recursive` skips `.terraform`, where `tofu init` puts the module checkout.
- The env of meddit's compose is a heredoc: `PUBLIC_HOST`, `POSTGRES_PASSWORD`, `CONNECTION_STRING`, each line ending with a newline. A module that writes the host's keys in sorted order, then `POSTGRES_PASSWORD`, then `CONNECTION_STRING`, each with a newline, gives the same string (probe: `same = true`). whatisgoingon's compose has no `env`.
- Dokploy writes the env of a raw compose to `code/.env` next to `code/docker-compose.yml`: `APP_NAME`, `COMPOSE_PROJECT_NAME`, the env string, then `DOCKER_CONFIG`. It runs `docker compose --env-file <dir>/.env`, which feeds `${VAR}` only. A service gets the keys only through `env_file: .env`. The provider sends the env as is and never reads it back (#4733 research, Dokploy 4e625a5, provider 7b560f5).
- The dokploy provider's source is `registry.terraform.io/ahmedali6/dokploy` in both hosts. In OpenTofu, `ahmedali6/dokploy` alone means `registry.opentofu.org/ahmedali6/dokploy`, which is another provider address.
- whatisgoingon's lock file has no `hashicorp/random`. meddit's has it.
- The project description of each host has its own text, and a change of it replaces the environment (the comment in both `main.tf` files, from text2sql's authx). `random_password.postgres` of meddit has no `prevent_destroy`.
- zukhruf's CI installs no OpenTofu, so the generator test "tofu fmt would change no .tf file" is skipped there.

## Decision

1. **The module is `packages/nx/opentofu/dokploy-stack`, and a host calls it with a git source pinned to a release tag.**

   ```hcl
   source = "git::https://github.com/JanuaryLabs/zukhruf.git//packages/nx/opentofu/dokploy-stack?ref=release/0.8.36&depth=1"
   ```

   The folder is inside the `nx` project, so a commit to the module is a commit of `@zukhruf/nx`, and the next release tags it. The generator writes the ref `release/<its own version>`, read from the `package.json` of `@zukhruf/nx`, as `init` reads it (ADR 0009, decision 4). The module and the generator that writes its call then have one version. A host moves to a new module by editing the ref in its `main.tf`, in a commit whose plan it can read.

   The actions stay at `@main`; #4675 defers their pinning until an identity can push the relocks. A module is pinned now, for 4 reasons. A module changes production resources, and at `@main` a push to zukhruf would change each host on its next deploy with no commit in the host. The host's gate would not see it, because the infra project did not change. The `typecheck` cache keys on the `.tf` files, so it would hide a change of the module. And the lock file records no module, so the lockfiles of #4675 would not cover it either. The tag is the lock. When #4675 builds its scheduled bump, the ref of each module call joins it.

   The npm package does not ship the folder: no host reads it from `node_modules`.

2. **One module holds the project, the adopted environment, the raw compose, and the optional Postgres password and GHCR registry.** The host root keeps the rest: `versions.tf`, `backend.tf`, `encryption.tf`, the providers, `data.hcloud_server.dokploy`, `local.dokploy_host`, `local.host`, the DNS record, each sensitive variable, each output, and each resource of the app, such as `random_password.better_auth`. The module configures no provider. It declares `dokploy` with the source `registry.terraform.io/ahmedali6/dokploy` (`~> 0.8`) and `random` with `hashicorp/random` (`~> 3.6`), the exact addresses of the root, so the root's provider configuration reaches it. It requires OpenTofu `>= 1.12.3`, as the hosts do.

   The optional parts are objects, as the generator's options are (ADR 0011, decision 12): `database = { role }` or `null`, `registry = { username, password }` or `null`. Neither can be on without its value.

   | Input          | Type                                               | Default | Validation, and its message                                                                                                                                                                                                                                             |
   | -------------- | -------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `name`         | `string`                                           | none    | `^[a-z][a-z0-9-]*$`: "The name is not a lowercase name that starts with a letter." It names the Dokploy project and the registry `<name>-ghcr`.                                                                                                                         |
   | `description`  | `string`                                           | none    | Not empty. The host's text, kept as it is: a change replaces the environment.                                                                                                                                                                                           |
   | `app`          | `string`                                           | none    | `^[a-z][a-z0-9-]*$`. The name of the compose in Dokploy.                                                                                                                                                                                                                |
   | `compose_file` | `string`                                           | none    | `can(yamldecode(...))`. Each `${NAME}` in it, after each `$$` is dropped, is a key that the env file gets (a precondition on the compose).                                                                                                                              |
   | `env`          | `map(string)`                                      | `{}`    | Each key matches `^[A-Za-z_][A-Za-z0-9_]*$`. No value is empty ("omit the key"), and no value holds a newline. No key is `APP_NAME`, `COMPOSE_PROJECT_NAME` or `DOCKER_CONFIG`, which Dokploy writes, nor, with `database`, `POSTGRES_PASSWORD` or `CONNECTION_STRING`. |
   | `database`     | `object({ role = string })`                        | `null`  | `role` matches `^[a-z_][a-z0-9_]*$`.                                                                                                                                                                                                                                    |
   | `registry`     | `object({ username = string, password = string })` | `null`  | `password` is not empty: "The GHCR pull token is empty: set the GHCR_PULL_TOKEN secret."                                                                                                                                                                                |

   The one output is `compose_id`. The host's `outputs.tf` passes it on under its own name: `compose_id` in meddit, `backend_compose_id` in whatisgoingon.

   Inside the module, the resources keep what the templates have today. `dokploy_project.this` has `prevent_destroy`. `dokploy_environment.production` has `prevent_destroy` and `ignore_changes = [name, description]`. `dokploy_compose.this` has `source_type = "raw"`, `auto_deploy = false`, `deploy_on_create = false` and `prevent_destroy`. `random_password.postgres[0]` has length 32 and no special characters, and it gains `prevent_destroy`: Postgres reads `POSTGRES_PASSWORD` only when it creates its volume, so a new password locks the backend out of the data. A lifecycle argument changes no plan. `dokploy_registry.ghcr[0]` has `registry_type = "cloud"` and the bare host `ghcr.io` (ADR 0011, decision 8).

   The env string is the host's keys in sorted order, then `POSTGRES_PASSWORD` and `CONNECTION_STRING=postgresql://<role>:<password>@postgres:5432/<role>` with `database`, each line ending with a newline. With no line, the env is `null`. That is meddit's string and whatisgoingon's `null` today, byte for byte.

3. **The compose is the repo's file, passed as `compose_file`, and the app reads its keys through `env_file: .env`.** The host passes `file("${path.module}/../../../compose.dokploy.yml")`; the module cannot read a file of the host, because its `path.module` is the module checkout. The app service declares `env_file: .env`, the file that Dokploy writes next to the compose. A key added to the module call then reaches the app with no edit of the compose. The other services keep explicit `${VAR}` keys: `postgres` reads `${POSTGRES_PASSWORD}`, and `migrate` reads only `${CONNECTION_STRING}`. The Traefik labels keep `${PUBLIC_HOST}` (ADR 0011, decision 10), and the host passes `PUBLIC_HOST = local.host` in `env`. The module does not add it, so whatisgoingon, which writes its host in its labels, gets no new key.

   The precondition on `${NAME}` takes over the generator test "each $ of the raw compose is a ${VAR} of the Dokploy environment or an escaped $$". The compose is now the repo's, so only a check at plan time still sees it.

4. **Each host moves under the module with `moved` blocks and no change in production.** The module call is `module "stack"`. The blocks go into a host file `moved.tf`, and they stay: Git is the state store, and a state restored from an older commit still has the old addresses.

   meddit:

   | From                             | To                                            |
   | -------------------------------- | --------------------------------------------- |
   | `dokploy_project.meddit`         | `module.stack.dokploy_project.this`           |
   | `dokploy_environment.production` | `module.stack.dokploy_environment.production` |
   | `dokploy_compose.backend`        | `module.stack.dokploy_compose.this`           |
   | `random_password.postgres`       | `module.stack.random_password.postgres[0]`    |
   | `dokploy_registry.ghcr`          | `module.stack.dokploy_registry.ghcr[0]`       |

   whatisgoingon:

   | From                             | To                                            |
   | -------------------------------- | --------------------------------------------- |
   | `dokploy_project.whatisgoingon`  | `module.stack.dokploy_project.this`           |
   | `dokploy_environment.production` | `module.stack.dokploy_environment.production` |
   | `dokploy_compose.backend`        | `module.stack.dokploy_compose.this`           |

   `hcloud_zone_rrset.whatisgoingon` and both `data.hcloud_server.dokploy` stay in the root. whatisgoingon deletes `imports.tf` in the same commit: its blocks would fail on the old addresses, and the state commits after 2afe449 (3fed880, 1e3ce13) hold the 4 resources. The move plan proves it: a resource missing from the state would plan a create. Rewritten to the module's addresses they would be skipped, and they would tie the host to the names inside the module. whatisgoingon also adds `hashicorp/random` to its lock file with `tofu providers lock -platform=linux_amd64 -platform=darwin_arm64`, which reads no state, because the module requires the provider even with `database = null`.

   Each host migrates in two commits:

   1. **The move.** The module call carries what the stack has today, with the description of each host as it is. The proof is `nx run @<scope>/infra:preview` and `show` on the operator's machine before the push: 5 (meddit) or 3 (whatisgoingon) "has moved to" lines, and "Plan: 0 to add, 0 to change, 0 to destroy". In CI the plan exits 2, so `tofu-apply` applies the move, commits the state, and reports `changed`, and the release job rolls the compose out once with the same compose and env.
   2. **The new keys** (meddit only). The plan updates `module.stack.dokploy_compose.this` in place: `env`, shown as `(sensitive value)` because the password is in it, and `compose_file_content`, for the `env_file` line. The human plan cannot show the env lines, so the proof is a set comparison on the operator's machine: `tofu show -json tfplan | jq` gives the env before and after, and the lines after are the lines before plus the new keys. The JSON holds the secrets in plain text, so it never runs in CI.

5. **The module is tested with `tofu test` and a mock provider, and the generator on a virtual `Tree`.** The module's tests are `.tftest.hcl` files in `dokploy-stack/tests`, with `mock_provider "dokploy"` and `mock_provider "random"`, and `command = plan` only: an apply run cannot clean up its `prevent_destroy` resources and leaves `errored_test.tfstate` while it passes. A Node test of `@zukhruf/nx` copies the folder to a temporary directory and runs `tofu fmt -check`, `tofu init`, `tofu validate` and `tofu test` there, so no test writes into the source tree. It skips when `tofu` is not on the PATH, like the fmt test of the generator, and zukhruf's CI gets the `opentofu/setup-opentofu@v2` step so that neither test is skipped in CI any more.

   The module's tests, each named by the break it catches:

   - The env is the host's keys in sorted order with a newline after each, and `null` with no key.
   - `database` adds `POSTGRES_PASSWORD` and `CONNECTION_STRING` after the host's keys, with the role in the user, the database and the URL.
   - A host key that the module or Dokploy writes, an empty value, a value with a newline, and a key that is not an env name are refused, each with its message.
   - A `${NAME}` in the compose that no key gives is refused, and `$${NAME}` is not.
   - The compose is raw, with `auto_deploy` and `deploy_on_create` off.
   - `registry` adds one registry `<name>-ghcr` at `ghcr.io`; `null` adds none, and neither does `database = null` add a password.
   - `compose_id` is the ID of the compose.

   `prevent_destroy` and `ignore_changes` cannot be asserted by `tofu test`. The move plans of decision 4 prove them on the two real states.

   The generator's tests on a virtual `Tree`:

   - A first run writes `main.tf` with the module call at `ref=release/<version of @zukhruf/nx>`, the compose with `env_file: .env` on the app, and no `registry.tf`.
   - A second run with the same options changes nothing.
   - A second run keeps a `main.tf`, a compose and a `variables.tf` that the repo edited. This replaces "a run without the registry removes the registry of an earlier run".
   - With `tofu` on the PATH, the generated `infra/` validates with the source of the module call pointed at the module in the checkout, for each host mode with and without Postgres and the registry. That catches an input that the generator writes and the module does not have. The fmt test stays.

6. **The auth generator adds its keys to the module call at a marker, and the host adds its own keys by hand.** The dokploy generator writes the `env` map of the module call with a marker comment as its last line. Part B of the auth generator inserts `BETTER_AUTH_SECRET = random_password.better_auth.result` and `BETTER_AUTH_URL = "https://${local.host}"` above the marker, as the prisma and auth generators insert into `env.ts`, and stops with an error that names the two lines when the marker is gone. A second run finds the keys and adds nothing. It writes `auth.tf` once, with `random_password.better_auth` (no special characters, at least 32 characters for `z.string().min(32)`) and `prevent_destroy`, because a new secret signs every user out (text2sql #398). The resource is the host's, not the module's: the module would not need it if no host had auth. The random provider is in each host, because the module requires it.

   A host's own key goes into the same map. meddit adds `MAIL_FROM = "onboarding@resend.dev"` and `RESEND_API_KEY = var.resend_api_key`. The variable goes into `variables.tf`, sensitive and refusing an empty value, as each variable does. The secret flows from the GitHub secret `RESEND_API_KEY` to `deploy.yml`, whose `TF_ENV` gets `"TF_VAR_resend_api_key": ${{ toJSON(secrets.RESEND_API_KEY) }}` beside the pull token, to `tofu-apply`, which exports it and masks its value. `infra/.env.example` gets `RESEND_API_KEY=` and `TF_VAR_resend_api_key=${RESEND_API_KEY}` for the local preview. All four files are the repo's.

7. **The generator writes each file of `infra/` only when it is missing, as it writes the workflows.** This supersedes the ownership rule of ADR 0011 decision 17: "Write once, repo owns it" (the owner, #3344) now covers `infra/` too. `main.tf` calls the module; `registry.tf` goes, and a registry is the `registry` input in `main.tf`. A run never deletes a file. A repo that drops the registry edits its `main.tf`, `variables.tf` and `deploy.yml` itself. The lock file always has `hashicorp/random`. `.prettierignore`, `.nxignore` and the `nx.json` plugin entry are merged as before.

   The module's README gives the inputs, the output, the contract of the compose, and who moves onto it. `README.md` `## dokploy generator` gets the module call in the same commit as the code.

## Considered Options

- **The module from `node_modules/@zukhruf/nx/...`.** REJECTED. `tofu-apply.yml` runs no `npm ci` before `tofu init`, so CI would need Node, an install and its cache in the apply job, and `typecheck` would depend on an install. Its one strength is that the package lock pins the module with the generator; the release tag does the same.
- **The OpenTofu registry.** REJECTED. A registry module needs its own repository named `terraform-<provider>-<name>` and its own tags. It splits the module from the generator that writes its call.
- **The ref `@main`, as the actions.** REJECTED, for the 4 reasons of decision 1.
- **The ref as a commit hash.** Not selected. A hash cannot be moved, but the zizmor config of the hosts already chose tags and `@main` over hashes (`ref-pin`), and a hash does not say which release it is.
- **The module at the root of the repo, as `.github/actions` is.** REJECTED. No Nx project would hold it, so its commits would not trigger a release or a tag, and no test target would run its tests.
- **Three modules: the stack, the registry and the Postgres password.** Not selected. Each host would bump three refs in step, and the registry and the password are never used without the compose. Its gain is that whatisgoingon would not need `hashicorp/random` in its lock file.
- **The Postgres password and `CONNECTION_STRING` in the host root.** Not selected. They are the same knowledge in each host with a database, and text2sql v2 has the same shape. The cost is a contract: the compose names its Postgres service `postgres` on port 5432, with the role as user and database. The generator writes such a compose, and the module's README states the contract.
- **The module adds `PUBLIC_HOST` itself.** Not selected. whatisgoingon would get a new key, and the move would no longer plan zero changes.
- **Explicit keys in the compose (`RESEND_API_KEY: ${RESEND_API_KEY}`).** Not selected. Each key would be in two files of the repo, a key that is missing from the compose reaches no one and fails only at boot, and the auth generator would have to edit YAML that the repo owns. `env_file` gives the app every key of the env file, also `POSTGRES_PASSWORD` (already in `CONNECTION_STRING`), `APP_NAME`, `COMPOSE_PROJECT_NAME` and `DOCKER_CONFIG`.
- **The seam of #4733's research: a written-once `app.tf` with `locals { app_env }` appended to the heredoc.** Replaced by this design, as the owner approved. It kept the delivery logic in each host's files.
- **Keys from the backend's `.env.example`, or generator options in `nx.json`.** REJECTED in #4733's research. The example holds development values, and an option applies to each project of a workspace.
- **Keep `imports.tf` with the module's addresses.** Not selected; see decision 4.
- **An `apply` run in `tofu test`.** REJECTED. It passes and leaves `errored_test.tfstate` behind.
- **Move text2sql's stacks.** Not in this design. v2 has the same shape and can move later with `database = null` and its prefixed keys in `env`. authx calls its own `authx-stack` module, and diagnostics has another shape. Neither is a generator host.

## Consequences

- meddit unblocks #4725 with the second commit of decision 4, and the auth generator's part B has a place for its keys.
- A fix of the delivery reaches a host only when the host bumps its ref. Until #4675 schedules the bumps, that is a commit by hand in each host.
- `tofu init` and `typecheck` clone 79 MB of zukhruf for each working directory, so `typecheck` downloads it a second time into `.terraform/validate`. Both need GitHub to answer.
- A generator fix to a file of `infra/` no longer reaches a host that ran the generator. The file is the repo's; the release notes say what to change.
- The app sees each key of the env file. Dokploy writes the file only while "create env file" is on; the provider never sends that flag, and the default is on. A change of it in the panel is drift that no plan shows.
- whatisgoingon's lock file gains `hashicorp/random`, which no resource of it uses.
- `CONTEXT.md` gets OpenTofu module and module call. Every other doc keeps the word "module" for OpenTofu only; a part of the package is an area.
- Steps: (2) the module, its tests and the generator change, after the owner rules; (3) the two-commit migration of meddit and whatisgoingon; (4) part B of the auth generator.
