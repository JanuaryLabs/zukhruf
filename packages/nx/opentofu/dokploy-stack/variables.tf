variable "name" {
  description = "The Dokploy project. The GHCR registry is <name>-ghcr."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*$", var.name))
    error_message = "The name is not a lowercase name that starts with a letter."
  }
}

variable "description" {
  description = "The description of the Dokploy project. Keep it as it is: a change replaces the environment."
  type        = string

  validation {
    condition     = length(var.description) > 0
    error_message = "The description is empty."
  }
}

variable "app" {
  description = "The name of the compose in Dokploy."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*$", var.app))
    error_message = "The app is not a lowercase name that starts with a letter."
  }
}

variable "compose_file" {
  description = "The content of the host's raw compose, for example file(\"$${path.module}/../../../compose.dokploy.yml\")."
  type        = string

  validation {
    condition     = can(yamldecode(var.compose_file))
    error_message = "The compose file is not YAML."
  }
}

variable "env" {
  description = "The host's keys of the env file that Dokploy writes next to the compose."
  type        = map(string)
  default     = {}
  nullable    = false

  validation {
    condition     = alltrue([for key in keys(var.env) : can(regex("^[A-Za-z_][A-Za-z0-9_]*$", key))])
    error_message = "A key of env is not an env name: a letter or _, then letters, digits or _."
  }

  validation {
    condition     = alltrue([for value in values(var.env) : value != ""])
    error_message = "A value of env is empty: omit the key."
  }

  validation {
    condition     = alltrue([for value in values(var.env) : !strcontains(value, "\n")])
    error_message = "A value of env holds a newline, which would end its line of the env file."
  }

  validation {
    condition     = length(setintersection(keys(var.env), ["APP_NAME", "COMPOSE_PROJECT_NAME", "DOCKER_CONFIG"])) == 0
    error_message = "env names APP_NAME, COMPOSE_PROJECT_NAME or DOCKER_CONFIG, which Dokploy writes."
  }

  validation {
    condition     = var.database == null || length(setintersection(keys(var.env), ["POSTGRES_PASSWORD", "CONNECTION_STRING"])) == 0
    error_message = "env names POSTGRES_PASSWORD or CONNECTION_STRING, which the module writes with database."
  }
}

variable "database" {
  description = "Postgres: the module adds POSTGRES_PASSWORD and CONNECTION_STRING for the role, which is the user and the database. null for none."
  type = object({
    role = string
  })
  default = null

  validation {
    condition     = var.database == null ? true : can(regex("^[a-z_][a-z0-9_]*$", var.database.role))
    error_message = "The database role is not a lowercase Postgres name."
  }
}

variable "registry" {
  description = "The GHCR login of the server, for private images: the GitHub user and a classic token with read:packages. null for none."
  type = object({
    username = string
    password = string
  })
  default = null

  validation {
    condition     = var.registry == null ? true : length(var.registry.password) > 0
    error_message = "The GHCR pull token is empty: set the GHCR_PULL_TOKEN secret."
  }
}
