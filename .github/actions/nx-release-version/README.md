# nx-release-version

Runs `nx release version` for the checked-out commit. Nx writes the versions that the conventional commits since the newest `release/*` tag ask into the checkout only: the action passes `gitCommit`, `gitTag`, `gitPush` and `stageChanges` as `false`, whatever `release.version.git` in `nx.json` says, so the release makes no commit, no tag and no push ([ADR 0008](../../../docs/adr/0008-the-release-writes-no-commit-and-tags-the-pushed-commit.md)). The lock file is not updated: nothing reads it after this step.

Nx reads the current version from the newest release tag that the commit holds, because `version.conventionalCommits: true` sets the `git-tag` resolver. When a release tag already names the commit, a run of this commit made the tag and stopped before the end (#4692). The action then writes the version of that tag again and sets `tagged` to `'true'`, so the publish sends what npm does not have and the job makes no tag. A commit with nothing to release, such as one with only `docs` commits since the tag, leaves `version` empty.

```yaml
permissions:
  contents: write # release-tag makes the tag
  id-token: write # npm provenance
steps:
  - uses: actions/checkout@v7
    with:
      ref: ${{ github.sha }}
      fetch-depth: 0
      persist-credentials: false
  - uses: JanuaryLabs/zukhruf/.github/actions/setup-workspace@main
    with:
      registry-url: https://registry.npmjs.org/
  - id: version
    uses: JanuaryLabs/zukhruf/.github/actions/nx-release-version@main
  - if: steps.version.outputs.version != '' && steps.version.outputs.tagged == 'false'
    uses: JanuaryLabs/zukhruf/.github/actions/release-tag@main
    with:
      version: ${{ steps.version.outputs.version }}
  - if: steps.version.outputs.version != ''
    uses: JanuaryLabs/zukhruf/.github/actions/nx-release-publish@main
    with:
      token: ${{ secrets.NPM_ACCESS_TOKEN }}
```

| Output    | Meaning                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| `version` | The version that the commit releases; empty when it has nothing to release.        |
| `tagged`  | `'true'` when a release tag already names the commit, `'false'` when it needs one. |

`nx.json` needs `releaseTag.pattern: release/{version}` and `version.conventionalCommits: true`, as `@zukhruf/nx/release.json` has. The checkout needs `fetch-depth: 0`, so that the tags and the history are there. The `preVersionCommand` runs with `node_modules/.bin` on `PATH`, so it can call `nx`. [`version.mjs`](version.mjs) runs from the workspace root as `node --input-type=module - < version.mjs`. Pin `@main`, as with `setup-workspace`.
