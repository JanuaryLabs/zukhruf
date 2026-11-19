# dokploy-stack

An OpenTofu module that stores a raw compose in Dokploy: the project, its adopted `production` environment, the compose with its env, and, when asked, a Postgres password and a GHCR registry. A host's `infra/` calls it from the root module that `@zukhruf/nx:dokploy` writes once. [ADR 0015](../../docs/adr/0015-an-opentofu-module-of-zukhruf-holds-the-dokploy-delivery-and-the-dokploy-generator-writes-infra-once.md) has the decisions and their reasons.

## Use it

```hcl
module "stack" {
  source = "git::https://github.com/JanuaryLabs/zukhruf.git//packages/nx/opentofu/dokploy-stack?ref=main"

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

The host configures the `dokploy` and `random` providers. The module configures none, and requires `registry.terraform.io/ahmedali6/dokploy` (`~> 0.8`) and `hashicorp/random` (`~> 3.6`), so the host's lock file has both, even without `database`.

The ref is `main`, as zukhruf's actions are called. A change to the module reaches each host on its next deploy, with no commit in the host. A local `tofu init` keeps the checkout it fetched first; `tofu init -upgrade` fetches `main` again.

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
- Each `${NAME}` is a key of `env`, a key that `database` adds, or `APP_NAME`, `COMPOSE_PROJECT_NAME` or `DOCKER_CONFIG`, which Dokploy writes. A plan refuses any other name. A literal dollar sign is `$$`.

## The env

The env is the keys of `env` in sorted order, then, with `database`, `POSTGRES_PASSWORD` and `CONNECTION_STRING=postgresql://<role>:<password>@postgres:5432/<role>`, each line ending with a newline. With no line, it is `null`.

## Lifecycle

`prevent_destroy` is on the project, the environment, the compose and the Postgres password. The environment ignores changes to its `name` and `description`, because the module adopts the one that Dokploy creates.

## Test it

`npx nx run nx:test` copies the module to a temporary folder and runs `tofu fmt -check`, `tofu init`, `tofu validate` and `tofu test` there; it skips when `tofu` is not on the PATH. The tests in `tests/` run `command = plan` with `mock_provider`, because an apply run cannot clean up the `prevent_destroy` resources. To run them by hand, run the same commands in a copy, so that `tofu init` writes nothing here.

## Who moves onto it

| Host                        | Stack                                        | Status                                                                                              |
| --------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| meddit                      | `infra/`: Postgres, GHCR registry, sslip.io  | Planned (#4733 step 3): 5 `moved` blocks, then the mailer's keys.                                   |
| whatisgoingon               | `infra/`: DNS record in the root, no env     | Planned (#4733 step 3): 3 `moved` blocks; `imports.tf` goes; the lock file gets `hashicorp/random`. |
| text2sql v2                 | `apps/v2/terraform`: Postgres, prefixed keys | Can move later with `database = null` and its own keys in `env`. Not planned.                       |
| text2sql authx, diagnostics | Their own modules and shapes                 | Stay out.                                                                                           |
