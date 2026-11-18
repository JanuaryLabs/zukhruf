# dokploy-deploy

Deploys a Dokploy compose and waits until the deployment it started is done. `compose.deploy` only queues the rollout, so the action notes the compose's deployment ids first, then polls `compose.one` every 5 seconds, for up to 10 minutes, until a new deployment is `done`. It fails when that deployment is `error` or `cancelled`. A health check after it reaches the new containers.

```yaml
- uses: JanuaryLabs/zukhruf/.github/actions/dokploy-deploy@main
  with:
    api-url: ${{ fromJSON(needs.infra.outputs.outputs).dokploy_api }}
    api-key: ${{ secrets.DOKPLOY_API_KEY }}
    compose-id: ${{ fromJSON(needs.infra.outputs.outputs).backend_compose_id }}
```

| Input        | Meaning                                     |
| ------------ | ------------------------------------------- |
| `api-url`    | The Dokploy API base URL, ending in `/api`. |
| `api-key`    | A Dokploy API key, sent as `x-api-key`.     |
| `compose-id` | The ID of the compose to deploy.            |

The `needs.infra.outputs.outputs` above comes from the reusable workflow [`tofu-apply.yml`](../../workflows/tofu-apply.yml), which publishes the stack's non-sensitive outputs as JSON.

Pin `@main`, as with `setup-workspace`. [`deploy-compose.sh`](deploy-compose.sh) also runs on its own: `DOKPLOY_API_KEY=… sh deploy-compose.sh <api-url> <compose-id>`.
