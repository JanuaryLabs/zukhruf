output "compose_id" {
  description = "Dokploy compose ID of the stack, for API calls such as compose.one and compose.deploy."
  value       = dokploy_compose.this.id
}
