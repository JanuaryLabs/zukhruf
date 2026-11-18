#!/bin/sh
set -eu

# Polls a health URL until it answers 200.
#
# With an expected sha, a 200 counts only when the body reports that commit as
# its `sha`. A rollout call returns before the old container is gone, so
# without it the check passes against the container being replaced (text2sql
# saw a green run followed by a restart-looping backend, its #1980).
url="${1:?usage: wait-for-health.sh <url> [expected-sha] [attempts] [delay-seconds]}"
expected_sha="${2:-}"
attempts="${3:-30}"
delay_seconds="${4:-10}"
attempt=1

while [ "$attempt" -le "$attempts" ]; do
  # `|| true`: curl exits non-zero (7) when it cannot connect, which set -e
  # would turn into an abort; its --write-out code (000) is still captured.
  body_file="$(mktemp)"
  status="$(curl --silent --show-error --output "$body_file" --write-out '%{http_code}' --max-time 10 "$url" || true)"
  body="$(cat "$body_file")"
  rm -f "$body_file"
  if [ "$status" = "200" ]; then
    if [ -z "$expected_sha" ]; then
      echo "Healthy: $url"
      exit 0
    fi
    case "$body" in
      *"\"sha\":\"$expected_sha\""*)
        echo "Healthy at $expected_sha: $url"
        exit 0
        ;;
    esac
    echo "Health attempt $attempt/$attempts returned 200 from another build: $body"
  else
    echo "Health attempt $attempt/$attempts returned $status"
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -le "$attempts" ]; then
    sleep "$delay_seconds"
  fi
done

echo "Timed out waiting for $url${expected_sha:+ at $expected_sha}" >&2
exit 1
