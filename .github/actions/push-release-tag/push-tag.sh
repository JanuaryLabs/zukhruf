#!/bin/sh
set -eu

# Pushes refs/tags/release/<version> to origin and prints pushed=true, or
# pushed=false when GitHub refuses it for a workflow. GITHUB_TOKEN can never
# change a workflow, and GitHub refuses a new tag whose workflow files differ
# from main's: a push changed a workflow while this release ran. That push
# started its own Release run, which releases these commits too (zukhruf
# docs/adr/0007). Any other refusal fails.
tag="refs/tags/release/$1"

if output="$(git push --porcelain origin "$tag" 2>&1)"; then
  printf '%s\n' "$output" >&2
  echo "pushed=true"
  exit 0
fi
printf '%s\n' "$output" >&2

case "$output" in
  *'to create or update workflow'*)
    main="$(git ls-remote origin refs/heads/main | cut -f1)"
    echo "main moved to $main, which changes a workflow, so GitHub refused the tag. The Release run of that push releases these commits." >&2
    echo "pushed=false"
    ;;
  *) exit 1 ;;
esac
