# The dokploy generator writes the GitOps delivery of a node-app

Status: Accepted 2026-11-18 by the owner (backlog #4603), decisions 1 to 22. meddit runs on it in production. Amended 2026-11-18 (#3344): decisions 3, 15, 17 and 22, after zukhruf's actions became building blocks that each repo composes.

text2sql (`apps/v2/terraform`, `apps/authx/terraform`) and whatisgoingon (`infra/`) deliver a backend to Dokploy the same way: an OpenTofu project with its encrypted state committed in Git, a raw compose that OpenTofu stores in Dokploy, and a deploy workflow that builds the images, applies the project and rolls the compose out. meddit is the third repo of the shape, so it moves here (#4603, strike 3). whatisgoingon after 402e87b and c9e5d7b is the working reference: it runs in production on zukhruf's kit, `tofu-apply.yml` and the `dokploy-deploy` and `wait-for-health` actions (#3273), and on `@zukhruf/nx/opentofu` (#3339). text2sql v2 is the reference for Postgres and the migrate service.

Facts read on 2026-11-18:

- `postgres:18-alpine` sets `PGDATA=/var/lib/postgresql/18/docker` and declares the volume `/var/lib/postgresql` (`docker image inspect`). A compose with the volume at `/var/lib/postgresql` came up healthy, and `show data_directory` gave `/var/lib/postgresql/18/docker`.
- `dokploy_registry` of provider 0.8.0 requires `registry_name`, `registry_url`, `username`, `password` and `image_prefix`; `registry_type` takes only `cloud` (`tofu providers schema -json`).
- With an empty `TF_VAR_dokploy_api_key` and `TF_VAR_ghcr_pull_token`, `tofu plan` stops with the two validation messages. With an empty passphrase, `tofu init` stops earlier, in pbkdf2 ("no passphrase provided").
- sslip.io is not on the Public Suffix List (`publicsuffix.org/list/public_suffix_list.dat`), so Let's Encrypt counts each sslip.io certificate against one registered domain.
- actionlint 1.7.12, the latest, refuses the `parallel:` step, which GitHub runs in whatisgoingon's and zukhruf's CI.

## Decision

The package gets the generator `dokploy` in `generators.json`. The README section `## dokploy generator` gives the files.

1. **The infra project has the shape of #4603.** `infra/project.json` names `@<scope>/infra`. `src/environments/production` holds `versions.tf` (OpenTofu >= 1.12.3, `ahmedali6/dokploy ~> 0.8`, `hetznercloud/hcloud ~> 1.66.0`, and `hashicorp/random ~> 3.6` with Postgres), `backend.tf` (local, state at `infra/src/terraform.tfstate`), `encryption.tf` (pbkdf2 and aes_gcm named after the project, state and plan enforced), `providers.tf`, `dns.tf` (`data.hcloud_server`, always), `main.tf` (the project with a stable description and `prevent_destroy`, the adopted default environment with `ignore_changes`, the raw compose with `auto_deploy = false` and `deploy_on_create = false`), `outputs.tf` (`dokploy_api`, `compose_id`) and `variables.tf` (#4603 DESIGN).
2. **No `terraform_data` deployment.** The release job deploys when a new image was promoted, when `tofu-apply` reports `changed`, or when the gate finds the infra project affected since the last successful deploy, so a re-run retries a failed rollout. `wait-for-health` gets the commit only after a new image (#4603, Z4 contract).
3. **The kit is called at `@main`**: `tofu-apply.yml` with `stack: infra`, `state_file` and the 3 secrets, `permissions: contents: write`; `dokploy-deploy` with the API and compose ID from `fromJSON(needs.infra.outputs.outputs)`; `wait-for-health` (#3273). The gate runs `tested-commit`, `affected-range` with `workflow-id: deploy.yml` and `affected-projects`; the image and promote jobs run `ghcr-image` and `ghcr-promote` (#3344).
4. **`@zukhruf/nx/opentofu` comes after `@zukhruf/nx/format` in `nx.json`, and the compose is inside the project root**, where the freshness check sees it. `.env.example` maps `TF_VAR_dokploy_api_key=${DOKPLOY_API_KEY}` with unquoted values (#3339, ADR 0007).
5. **The lock file has the hashes of `linux_amd64` and `darwin_arm64`**, because `typecheck` runs `init -lockfile=readonly` (#3339, ADR 0002).
6. **The host is a DNS name in a Hetzner zone, or `<name>.<ipv4>.sslip.io`.** A DNS name gets an `hcloud_zone_rrset` A record (TTL 60, `change_protection`, `prevent_destroy`); sslip.io gets no DNS resource (#4603, the owner for meddit).
7. **Postgres is `postgres:18-alpine` with the volume at `/var/lib/postgresql` and no `PGDATA`**, a `pg_isready` health check on `127.0.0.1`, on the default network only; the one-shot `migrate` runs `ghcr.io/<owner>/<name>-migrate:latest` from the Prisma package's `Dockerfile.migration` after Postgres is healthy, and the app waits for it to complete. `random_password.postgres` (32, no special characters) gives `POSTGRES_PASSWORD` and `CONNECTION_STRING` (#4603).
8. **Private images use a Dokploy registry**: `dokploy_registry` with `registry_type = "cloud"`, `registry_url = "ghcr.io"` (a bare host: Dokploy refuses a scheme, found by meddit's first deploy), `image_prefix = "ghcr.io"`, and the classic read:packages token `GHCR_PULL_TOKEN`, passed to `tofu-apply` as `TF_ENV` `TF_VAR_ghcr_pull_token` (#4603, PRIVATE IMAGES).
9. **Each variable refuses an empty value, the GHCR owner is lowercase, and each file is a string in a `.ts` module** tested on a virtual `Tree` (#4603, ADR 0009 decision 8, ADR 0010 decision 9).
10. **The host reaches the compose as `PUBLIC_HOST`.** The Traefik rules read ``Host(`${PUBLIC_HOST}`)``, and `main.tf` stores `PUBLIC_HOST=${local.host}` in the compose env. One compose serves both host modes; the sslip.io address is known only to OpenTofu. whatisgoingon writes the name in the labels.
11. **The stack outputs `host`, and the release job waits for `https://<host>/api/healthz`.** whatisgoingon writes the URL in the workflow, which an sslip.io host cannot.
12. **An option that adds a part names what the part needs.** `database` is the root of the Prisma package, and `registryUser` is the GitHub user of the token, so neither has a boolean that could be on without its value. The generator maps them to a `Database` and a `Registry`, and the host to `DnsHost | SslipHost`.
13. **`owner` is required.** The compose names its images in full, and the generator cannot read the remote of the repo from the `Tree`.
14. **The names come from `name`, by default the workspace scope**: the Dokploy project, the images `<name>-<app>` (the tag of `docker:build`) and `<name>-migrate`, the Traefik routers `<name>-web` and `<name>-websecure`, the encryption labels, and the address `dokploy_project.<name>`. The compose is `dokploy_compose.<app>`. whatisgoingon's addresses come out the same (`whatisgoingon`, `backend`). The Postgres role is `name` with `_` for `-`.
15. **The images build in a matrix job and move to `:latest` in a second job**, as text2sql v2 does, so `:latest` moves only after each image of the commit exists. whatisgoingon has one image and promotes in the build job. The release checks the commit when `promote` succeeded. Both jobs call zukhruf's `ghcr-image` and `ghcr-promote` (#3344).
16. **A new image follows a change of each project that the Dockerfile builds and of the Prisma package.** The gate reads the `--projects` list of the Dockerfile that `node-app` and `pair` write, so a paired web app is in it. The migrate image builds next to the app image.
17. **The generator owns the files of `infra/`, and writes `ci.yml`, `deploy.yml` and `.github/zizmor.yml` only when they are missing.** Once written, a workflow is the repo's: it composes zukhruf's actions with steps of its own (the owner, 2026-11-18, #3344: "Write once, repo owns it"). A run writes the files of `infra/` again, and deletes `registry.tf` when `registryUser` is gone; a repo that drops the registry then drops `TF_ENV` from its `deploy.yml` itself. A CI with another `name` than `CI` does not start the deploy.
18. **The provider constraints and their lock blocks are in `dokploy/providers.ts`**, not in `versions.ts`: a constraint and its hashes change together, and only this generator writes them.
19. **`.prettierignore` gets `.terraform`, `tfplan` and `infra/src/terraform.tfstate`.** Prettier reads the root ignore files only, and the smoke test found `prettier --check .` failing on the provider cache that `typecheck` writes.
20. **The infra project is `infra/`, named `@<scope>/infra`**, as in whatisgoingon. It has no option for its folder (strike 1).
21. **The generator does not run `init`.** It needs a node-app, whose generator ran `init`.
22. **`ci.yml` runs the checks of the whole tree as background steps beside `nx affected`, and zizmor audits the workflows.** actionlint 1.7.12 refuses `parallel:` and `background:` steps and has no `$/` (its #760); zizmor 1.32 reads all three (#3344). `.github/zizmor.yml` allows tags and `@main` (`ref-pin`) and the `workflow_run` of `deploy.yml`, which checks out main after a green push run of CI.

## Considered Options

- **The host written in the labels, as in whatisgoingon.** Not selected. The sslip.io address comes from `data.hcloud_server`, so the compose would need a second shape.
- **`postgres: boolean` and `privateRegistry: boolean` options.** REJECTED. A boolean on without its path or user is a state the generator would have to refuse at run time.
- **Read the owner from `git remote get-url origin`.** Not selected. The `Tree` has no Git, and a generator that reads the disk around the `Tree` cannot be tested on a virtual one.
- **One image job that also promotes, as in whatisgoingon.** Not selected. With 2 images, the app could reach `:latest` while the migrate image fails.
- **Overwrite `ci.yml` on each run.** Not selected. It deletes the tuning of a repo with no warning.
- **Overwrite `deploy.yml` on each run.** Selected first, then replaced (#3344). It deletes the steps that a repo adds to its deploy.
- **Keep `PGDATA=/var/lib/postgresql/data/pgdata` with the volume at `/var/lib/postgresql/data`, as in text2sql v2 (Postgres 17).** REJECTED by #4603. Postgres 18 keeps the data of each major in its own folder under `/var/lib/postgresql`.
- **A `terraform_data` that runs the deploy script, as text2sql did.** REJECTED by #3273: the scripts live in zukhruf's actions, not in the caller's checkout.

## Consequences

- meddit gets its delivery from npm with one command after `prisma`. whatisgoingon and text2sql can switch later; whatisgoingon's addresses stay, and its output `backend_compose_id` becomes `compose_id`.
- The passphrase validation never fires: pbkdf2 refuses an empty passphrase first. It stays, so each variable has one.
- Let's Encrypt can refuse a certificate for an sslip.io host when the world's sslip.io certificates of the week reach the limit. Traefik then serves its default certificate, and `wait-for-health` fails on TLS. Check at meddit's first deploy.
- The Dokploy registry is the server's `docker login` for `ghcr.io`. A second stack on the same server with its own GHCR registry replaces that login, and every compose on the server then pulls with the last token.
- Private packages that are not linked to the repo need Actions write access in their package settings, or the image job cannot push (#4603).
- The smoke test runs `prisma` from the checkout, before #4604 is released; the tests write a stand-in `Dockerfile.migration`.
- `CONTEXT.md` gets infra project, release job, public host and pull registry.
