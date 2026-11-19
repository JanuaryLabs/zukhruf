terraform {
  required_version = ">= 1.12.3"

  # The addresses of the host root, so the providers that the host configures
  # reach the module. In OpenTofu, ahmedali6/dokploy alone would mean
  # registry.opentofu.org/ahmedali6/dokploy, another provider.
  required_providers {
    dokploy = {
      source  = "registry.terraform.io/ahmedali6/dokploy"
      version = "~> 0.8"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
