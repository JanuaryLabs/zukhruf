# Plan runs only: an apply run cannot destroy the prevent_destroy resources in
# its cleanup, and leaves errored_test.tfstate while it passes (ADR 0015).
mock_provider "dokploy" {
  mock_resource "dokploy_compose" {
    defaults = {
      id = "compose-1"
    }
  }
}

mock_provider "random" {}

variables {
  name         = "acme"
  description  = "acme at acme.example.com - managed by OpenTofu"
  app          = "backend"
  compose_file = "services:\n  backend:\n    image: ghcr.io/acme/acme-backend:latest\n"
}

run "the_compose_is_raw_with_auto_deploy_and_deploy_on_create_off" {
  command = plan

  assert {
    condition     = dokploy_compose.this.source_type == "raw" && dokploy_compose.this.auto_deploy == false && dokploy_compose.this.deploy_on_create == false
    error_message = "The compose is not raw with auto_deploy and deploy_on_create off."
  }

  assert {
    condition     = dokploy_compose.this.name == "backend" && dokploy_compose.this.compose_file_content == var.compose_file
    error_message = "The compose is not the app's, with the host's compose file."
  }

  assert {
    condition     = dokploy_project.this.name == "acme" && dokploy_project.this.description == var.description
    error_message = "The project does not have the name and the description of the host."
  }

  assert {
    condition     = dokploy_environment.production.name == "production"
    error_message = "The environment is not the adopted production environment."
  }
}

run "compose_id_is_the_id_of_the_compose" {
  command = plan

  assert {
    condition     = output.compose_id == "compose-1"
    error_message = "compose_id is not the ID of the compose."
  }
}

run "each_name_of_the_compose_that_a_key_gives_passes" {
  command = plan

  variables {
    compose_file = "services:\n  backend:\n    labels:\n      - 'Host(`$${PUBLIC_HOST}`)'\n      - 'project=$${COMPOSE_PROJECT_NAME}'\n  postgres:\n    environment:\n      POSTGRES_PASSWORD: $${POSTGRES_PASSWORD}\n"
    env          = { PUBLIC_HOST = "acme.example.com" }
    database     = { role = "acme" }
  }

  assert {
    condition     = dokploy_compose.this.compose_file_content == var.compose_file
    error_message = "The compose is not the host's."
  }
}

run "a_name_in_the_compose_that_no_key_gives_is_refused" {
  command = plan

  variables {
    compose_file = "services:\n  backend:\n    environment:\n      RESEND_API_KEY: $${RESEND_API_KEY}\n"
  }

  expect_failures = [dokploy_compose.this]
}

run "an_escaped_dollar_is_not_a_name" {
  command = plan

  # The compose says "echo $${HOME}": HCL keeps a $$ that no { follows, and
  # $ is a dollar sign that does not start an interpolation.
  variables {
    compose_file = "services:\n  backend:\n    command: echo $$${HOME}\n"
  }

  assert {
    condition     = strcontains(var.compose_file, "echo $$${HOME}") && dokploy_compose.this.compose_file_content == var.compose_file
    error_message = "The escaped name HOME was taken for a key of the env file."
  }
}

run "a_compose_that_is_not_yaml_is_refused" {
  command = plan

  variables {
    compose_file = "services: [backend"
  }

  expect_failures = [var.compose_file]
}
