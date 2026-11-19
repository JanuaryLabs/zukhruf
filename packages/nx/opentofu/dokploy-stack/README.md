# dokploy-stack

> **Design for review.** No `.tf` file exists yet. This README and [ADR 0015](../../docs/adr/0015-an-opentofu-module-of-zukhruf-holds-the-dokploy-delivery-and-the-dokploy-generator-writes-infra-once.md) are the design (#4733). The code comes after the owner rules.

An OpenTofu module that stores a raw compose in Dokploy: the project, its adopted `production` environment, the compose with its env, and, when asked, a Postgres password and a GHCR registry. A host's `infra/` calls it from the root module that `@zukhruf/nx:dokploy` writes once.

## Use it

```hcl
module "stack" {
  source = "git::https://github.com/JanuaryLabs/zukhruf.git//packages/nx/opentofu/dokploy-stack?ref=release/0.8.36&depth=1"

  name         = "meddit"
  description  = "meddit at meddit.<server ipv4>.sslip.io - managed by OpenTofu"
  app          = "backend"
  compose_file = file("${path.module}/../../../compose.dokploy.yml")
  database     = { role = "meddit" }
  registry     = { username = "ezzabuzaid", password = var.ghcr_pull_token }

  env = {
    PUBLIC_HOST    = local.host
    MAIL_FROM      = "onboarding@resend.dev"
    RESEND_API_KEY = var.resend_api_key
    # Generators add env keys above this line.
  }
}
```

The host configures the `dokploy` and `random` providers. The module configures none.

## Inputs

| Input          | Type                                               | Default | Rule                                                                                                                                                                                   |
| -------------- | -------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | `string`                                           | none    | `^[a-z][a-z0-9-]*$`. The Dokploy project; the registry is `<name>-ghcr`.                                                                                                               |
| `description`  | `string`                                           | none    | Not empty. Keep it as it is: a change replaces the environment.                                                                                                                        |
| `app`          | `string`                                           | none    | `^[a-z][a-z0-9-]*$`. The name of the compose.                                                                                                                                          |
| `compose_file` | `string`                                           | none    | YAML. Each `${NAME}` in it is a key of the env file.                                                                                                                                   |
| `env`          | `map(string)`                                      | `{}`    | Env names as keys; no empty value; no newline in a value; not `APP_NAME`, `COMPOSE_PROJECT_NAME` or `DOCKER_CONFIG`, nor, with `database`, `POSTGRES_PASSWORD` or `CONNECTION_STRING`. |
| `database`     | `object({ role = string })`                        | `null`  | `role` matches `^[a-z_][a-z0-9_]*$`.                                                                                                                                                   |
| `registry`     | `object({ username = string, password = string })` | `null`  | `password` is not empty.                                                                                                                                                               |

## Outputs

| Output       | Type     | Value                                                                      |
| ------------ | -------- | -------------------------------------------------------------------------- |
| `compose_id` | `string` | The Dokploy compose ID, for `compose.deploy` in the release job of a host. |

## The compose

The compose is the host's file. It meets this contract:

- The app service reads its keys with `env_file: .env`. Dokploy writes that file next to the compose.
- With `database`, the Postgres service is `postgres` on port 5432, with `POSTGRES_DB` and `POSTGRES_USER` set to the role and `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}`.
- Each `${NAME}` is a key of `env`, a key that `database` adds, `APP_NAME` or `COMPOSE_PROJECT_NAME`. A literal dollar sign is `$$`.

## Who moves onto it

| Host                        | Stack                                        | Status                                                                                              |
| --------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| meddit                      | `infra/`: Postgres, GHCR registry, sslip.io  | Planned (#4733 step 3): 5 `moved` blocks, then the mailer's keys.                                   |
| whatisgoingon               | `infra/`: DNS record in the root, no env     | Planned (#4733 step 3): 3 `moved` blocks; `imports.tf` goes; the lock file gets `hashicorp/random`. |
| text2sql v2                 | `apps/v2/terraform`: Postgres, prefixed keys | Can move later with `database = null` and its own keys in `env`. Not planned.                       |
| text2sql authx, diagnostics | Their own modules and shapes                 | Stay out.                                                                                           |
