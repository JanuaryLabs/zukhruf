# Plan runs only: an apply run cannot destroy the prevent_destroy resources in
# its cleanup, and leaves errored_test.tfstate while it passes (ADR 0015).
mock_provider "dokploy" {}

mock_provider "random" {}

variables {
  name         = "acme"
  description  = "acme at acme.example.com - managed by OpenTofu"
  app          = "backend"
  compose_file = "services:\n  backend:\n    image: ghcr.io/acme/acme-backend:latest\n"
}

run "registry_adds_one_ghcr_registry_named_after_the_stack" {
  command = plan

  variables {
    registry = { username = "octocat", password = "ghp_token" }
  }

  assert {
    condition     = length(dokploy_registry.ghcr) == 1
    error_message = "registry does not add one registry."
  }

  assert {
    condition     = dokploy_registry.ghcr[0].registry_name == "acme-ghcr" && dokploy_registry.ghcr[0].registry_type == "cloud" && dokploy_registry.ghcr[0].username == "octocat"
    error_message = "The registry is not the cloud registry acme-ghcr of octocat."
  }

  # Dokploy refuses a URL with a scheme.
  assert {
    condition     = dokploy_registry.ghcr[0].registry_url == "ghcr.io" && dokploy_registry.ghcr[0].image_prefix == "ghcr.io"
    error_message = "The registry is not at the bare host ghcr.io."
  }
}

run "no_registry_and_no_database_add_no_registry_and_no_password" {
  command = plan

  assert {
    condition     = length(dokploy_registry.ghcr) == 0
    error_message = "registry = null added a registry."
  }

  assert {
    condition     = length(random_password.postgres) == 0
    error_message = "database = null added a password."
  }
}

run "an_empty_pull_token_is_refused" {
  command = plan

  variables {
    registry = { username = "octocat", password = "" }
  }

  expect_failures = [var.registry]
}

run "a_name_that_is_not_lowercase_is_refused" {
  command = plan

  variables {
    name = "Acme"
  }

  expect_failures = [var.name]
}

run "an_app_that_is_not_lowercase_is_refused" {
  command = plan

  variables {
    app = "Backend"
  }

  expect_failures = [var.app]
}

run "an_empty_description_is_refused" {
  command = plan

  variables {
    description = ""
  }

  expect_failures = [var.description]
}
