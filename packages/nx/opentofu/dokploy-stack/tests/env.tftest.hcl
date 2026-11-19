# Plan runs only: an apply run cannot destroy the prevent_destroy resources in
# its cleanup, and leaves errored_test.tfstate while it passes (ADR 0015).
mock_provider "dokploy" {
  mock_resource "dokploy_compose" {
    defaults = {
      id = "compose-1"
    }
  }
}

mock_provider "random" {
  mock_resource "random_password" {
    defaults = {
      result = "s3cret"
    }
  }
}

variables {
  name         = "acme"
  description  = "acme at acme.example.com - managed by OpenTofu"
  app          = "backend"
  compose_file = "services:\n  backend:\n    image: ghcr.io/acme/acme-backend:latest\n"
}

run "the_env_is_the_host_keys_in_sorted_order_with_a_newline_after_each" {
  command = plan

  variables {
    env = {
      PUBLIC_HOST = "acme.example.com"
      MAIL_FROM   = "onboarding@resend.dev"
      A_KEY       = "a value with = and spaces"
    }
  }

  assert {
    condition     = dokploy_compose.this.env == "A_KEY=a value with = and spaces\nMAIL_FROM=onboarding@resend.dev\nPUBLIC_HOST=acme.example.com\n"
    error_message = "The env is not the host's keys in sorted order, each line ending with a newline."
  }
}

run "the_env_is_null_with_no_key" {
  command = plan

  assert {
    condition     = dokploy_compose.this.env == null
    error_message = "The env is not null with no key."
  }
}

run "database_adds_the_postgres_password_and_connection_string_after_the_host_keys" {
  command = plan

  variables {
    env      = { PUBLIC_HOST = "meddit.1.2.3.4.sslip.io" }
    database = { role = "meddit" }
  }

  # The string of meddit's env heredoc before the module, byte for byte.
  assert {
    condition     = dokploy_compose.this.env == "PUBLIC_HOST=meddit.1.2.3.4.sslip.io\nPOSTGRES_PASSWORD=s3cret\nCONNECTION_STRING=postgresql://meddit:s3cret@postgres:5432/meddit\n"
    error_message = "The env is not the host's keys, then POSTGRES_PASSWORD and CONNECTION_STRING with the role."
  }

  assert {
    condition     = length(random_password.postgres) == 1 && random_password.postgres[0].length == 32 && random_password.postgres[0].special == false
    error_message = "The Postgres password is not 32 characters without special characters."
  }
}

run "database_alone_gives_its_two_keys" {
  command = plan

  variables {
    database = { role = "my_app" }
  }

  assert {
    condition     = dokploy_compose.this.env == "POSTGRES_PASSWORD=s3cret\nCONNECTION_STRING=postgresql://my_app:s3cret@postgres:5432/my_app\n"
    error_message = "The env of a database with no host key is not its two keys."
  }
}

run "a_key_that_dokploy_writes_is_refused" {
  command = plan

  variables {
    env = { APP_NAME = "acme" }
  }

  expect_failures = [var.env]
}

run "a_key_that_the_database_writes_is_refused_with_database" {
  command = plan

  variables {
    env      = { CONNECTION_STRING = "postgresql://elsewhere" }
    database = { role = "acme" }
  }

  expect_failures = [var.env]
}

run "a_key_that_the_database_writes_is_a_host_key_without_database" {
  command = plan

  variables {
    env = { CONNECTION_STRING = "postgresql://elsewhere" }
  }

  assert {
    condition     = dokploy_compose.this.env == "CONNECTION_STRING=postgresql://elsewhere\n"
    error_message = "A host's CONNECTION_STRING without database is not its own key."
  }
}

run "an_empty_value_is_refused" {
  command = plan

  variables {
    env = { MAIL_FROM = "" }
  }

  expect_failures = [var.env]
}

run "a_value_with_a_newline_is_refused" {
  command = plan

  variables {
    env = { MAIL_FROM = "a\nINJECTED=1" }
  }

  expect_failures = [var.env]
}

run "a_key_that_is_not_an_env_name_is_refused" {
  command = plan

  variables {
    env = { "MAIL-FROM" = "onboarding@resend.dev" }
  }

  expect_failures = [var.env]
}

run "a_role_that_is_not_a_postgres_name_is_refused" {
  command = plan

  variables {
    database = { role = "my-app" }
  }

  expect_failures = [var.database]
}
