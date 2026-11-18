#!/bin/sh
set -eu

# Prints the base and head of the range that nx affected compares.
#
# The base is the newer of two commits:
# - the commit of the last successful run (the argument; empty when there is none)
# - the commit of the newest release/* tag that HEAD reaches
# A release commit changes every package.json and gets no CI run, so a base
# before it marks every project affected (zukhruf #3245). With neither commit,
# the base is the empty tree: every file differs, so every project is affected,
# and the caller needs no second command for a first run.
green="${1:-}"
base="$green"

tag="$(git describe --tags --abbrev=0 --match 'release/*' 2>/dev/null || true)"
if [ -n "$tag" ]; then
  tag_commit="$(git rev-list -n 1 "$tag")"
  if [ -z "$base" ] || git merge-base --is-ancestor "$base" "$tag_commit"; then
    base="$tag_commit"
  fi
fi

if [ -z "$base" ]; then
  base="$(git hash-object -t tree /dev/null)"
fi

echo "base=$base"
echo "head=$(git rev-parse HEAD)"
