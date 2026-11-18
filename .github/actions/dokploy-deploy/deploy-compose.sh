#!/bin/sh
set -eu

# Deploys a Dokploy compose and waits until the deployment it started is done.
#
# `compose.deploy` only queues the rollout. Dokploy writes the deployment record
# when its worker picks the job up, and it recreates the containers after that.
# A health check made right after the call reaches the old containers (text2sql
# printed "healthy" from the old backend on 2026-10-28, its #3219).
# So this script notes the compose's deployment ids before the call, waits for a
# new one, and exits 0 only when that deployment is `done`. Any record created
# after the call deploys the compose as stored now, so the newest new record is
# the rollout to watch. Dokploy's statuses: running | done | error | cancelled.
#
# Callers check health after this returns: the containers it reports are new.
api="${1:?usage: deploy-compose.sh <dokploy-api-url> <compose-id>}"
compose_id="${2:?usage: deploy-compose.sh <dokploy-api-url> <compose-id>}"
: "${DOKPLOY_API_KEY:?DOKPLOY_API_KEY is required}"
attempts=120
delay_seconds=5

compose_file="$(mktemp)"
trap 'rm -f "$compose_file"' EXIT HUP INT TERM

fetch_compose() {
  curl --fail --silent --show-error --max-time 30 \
    --header "x-api-key: $DOKPLOY_API_KEY" \
    --output "$compose_file" \
    "$api/compose.one?composeId=$compose_id"
}

fetch_compose
before="$(jq -c '[.deployments[].deploymentId]' "$compose_file")"

curl --fail --silent --show-error --max-time 30 --request POST \
  --header "x-api-key: $DOKPLOY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data-binary "{\"composeId\":\"$compose_id\"}" \
  "$api/compose.deploy" >/dev/null
echo "Deployment of compose $compose_id queued."

attempt=1
while [ "$attempt" -le "$attempts" ]; do
  sleep "$delay_seconds"
  # A failed read is retried: one dropped request must not fail a rollout.
  if fetch_compose; then
    deployment="$(jq -c --argjson before "$before" '
      [.deployments[] | select(.deploymentId | IN($before[]) | not)]
      | sort_by(.createdAt) | last // empty
      | {deploymentId, status, createdAt, errorMessage}
    ' "$compose_file")"
    status="$(printf '%s' "$deployment" | jq -r '.status // empty')"
    case "$status" in
      '')
        echo "Attempt $attempt/$attempts: no new deployment yet" ;;
      done)
        echo "Deployment is done: $deployment"
        exit 0 ;;
      error | cancelled)
        echo "Deployment failed: $deployment" >&2
        exit 1 ;;
      *)
        echo "Attempt $attempt/$attempts: deployment is $status" ;;
    esac
  fi
  attempt=$((attempt + 1))
done

echo "Deployment of compose $compose_id did not finish within $((attempts * delay_seconds)) s." >&2
exit 1
