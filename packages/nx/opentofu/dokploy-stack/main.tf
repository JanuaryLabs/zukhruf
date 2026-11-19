locals {
  # The host's keys in sorted order, then the keys of the database, each line
  # ending with a newline: the string of the hosts' env heredoc before the
  # module, byte for byte.
  env_lines = concat(
    [for key in sort(keys(var.env)) : "${key}=${var.env[key]}"],
    var.database == null ? [] : [
      "POSTGRES_PASSWORD=${random_password.postgres[0].result}",
      "CONNECTION_STRING=postgresql://${var.database.role}:${random_password.postgres[0].result}@postgres:5432/${var.database.role}",
    ],
  )
  env = length(local.env_lines) == 0 ? null : join("", [for line in local.env_lines : "${line}\n"])

  # Each key of the env file: the host's, the database's and Dokploy's own.
  env_keys = concat(
    keys(var.env),
    var.database == null ? [] : ["POSTGRES_PASSWORD", "CONNECTION_STRING"],
    ["APP_NAME", "COMPOSE_PROJECT_NAME", "DOCKER_CONFIG"],
  )
  # Each ${NAME} of the compose; $$ is a literal dollar sign.
  compose_names = distinct(flatten(regexall("\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}", replace(var.compose_file, "$$", ""))))
  missing_names = sort(setsubtract(local.compose_names, local.env_keys))
}

resource "dokploy_project" "this" {
  name = var.name
  # Required in practice: the provider writes the API's description into state
  # even when it is unset, and the attribute is not computed. Keep it stable:
  # the environment's project_id requires replacement.
  description = var.description

  lifecycle {
    prevent_destroy = true
  }
}

# Dokploy creates this protected default environment with every project and
# refuses to create another named "production"; provider 0.8 adopts it on
# create, so a single apply provisions the stack.
resource "dokploy_environment" "production" {
  name        = "production"
  description = "Production environment"
  project_id  = dokploy_project.this.id

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [name, description]
  }
}

# Postgres reads POSTGRES_PASSWORD only when it creates its volume, so a new
# password would lock the app out of its data.
resource "random_password" "postgres" {
  count = var.database == null ? 0 : 1

  length  = 32
  special = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "dokploy_compose" "this" {
  environment_id = dokploy_environment.production.id
  name           = var.app

  source_type          = "raw"
  compose_file_content = var.compose_file

  env = local.env

  # Deploys go through the API (compose.deploy), never the refresh-token
  # webhook, so auto_deploy stays off. deploy_on_create stays off so creating
  # the compose never launches a deployment that no job observes.
  auto_deploy      = false
  deploy_on_create = false

  lifecycle {
    prevent_destroy = true

    # Docker Compose would put an empty string in place of an unknown name.
    precondition {
      condition     = length(local.missing_names) == 0
      error_message = "The compose names ${join(", ", local.missing_names)}, which the env file does not have. Add each to env, or write a literal dollar sign as $$."
    }
  }
}

# Dokploy runs `docker login` on the server when it stores a registry, and a
# compose deploy pulls with that login, so the server pulls the private images.
# The login is the server's docker login for ghcr.io: each stack on the server
# that stores a GHCR registry replaces it. The URL is a bare host: Dokploy
# refuses one with a scheme ("Registry URL must be a valid hostname or
# hostname:port").
resource "dokploy_registry" "ghcr" {
  count = var.registry == null ? 0 : 1

  registry_name = "${var.name}-ghcr"
  registry_type = "cloud"
  registry_url  = "ghcr.io"
  image_prefix  = "ghcr.io"
  username      = var.registry.username
  password      = var.registry.password
}

# Updating dokploy_compose only stores the compose. The module does not deploy:
# the release job of the host's deploy workflow runs zukhruf's dokploy-deploy
# and wait-for-health actions.
