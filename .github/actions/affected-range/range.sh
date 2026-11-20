#!/bin/sh
set -eu

# Prints the base and head of the range that nx affected compares.
#
# The base is the newer of two commits:
# - the commit of the last successful run (the first argument; empty when there is none)
# - the commit of the newest tag that HEAD reaches and that the second argument
#   matches, release/* when it is not given
# A release commit changes every package.json and gets no CI run, so a base
# before it marks every project affected (zukhruf #3245). The tag is a base
# only when the host releases a commit after CI passed for it. A host that
# releases before CI passes gives an empty second argument, so a tag on an
# untested commit never hides the commits before it (zukhruf ADR 0007). With
# neither commit, the base is the empty tree: every file differs, so every
# project is affected, and the caller needs no second command for a first run.
green="${1:-}"
tested_tags="${2-release/*}"
base="$green"

if [ -n "$tested_tags" ]; then
  tag="$(git describe --tags --abbrev=0 --match "$tested_tags" 2>/dev/null || true)"
  if [ -n "$tag" ]; then
    tag_commit="$(git rev-list -n 1 "$tag")"
    if [ -z "$base" ] || git merge-base --is-ancestor "$base" "$tag_commit"; then
      base="$tag_commit"
    fi
  fi
fi

if [ -z "$base" ]; then
  base="$(git hash-object -t tree /dev/null)"
fi

echo "base=$base"
echo "head=$(git rev-parse HEAD)"
