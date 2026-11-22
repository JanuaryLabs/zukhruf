# release-tag

Makes the tag `release/<version>` on the pushed commit (`github.sha`) through the GitHub API (`gh api --method POST repos/<repository>/git/refs`), with the job's `GITHUB_TOKEN`. The tag names a commit that `main` already holds, so the API makes no new git object, runs no pre-push hook and starts no workflow run ([ADR 0008](../../../docs/adr/0008-the-release-writes-no-commit-and-tags-the-pushed-commit.md)).

The tag goes before the publish. The next release counts its commits from the newest release tag, so a version reaches npm only once its tag is there.

When GitHub refuses the tag, the step fails and the job publishes nothing. "Reference already exists" (HTTP 422) means that a release tag of this version names another commit: the commit did not hold the newest tag, and Nx computed the version of that tag again. The Release run of the next push counts from the tag before and releases the same commits.

```yaml
permissions:
  contents: write # the tag
steps:
  - id: version
    uses: JanuaryLabs/zukhruf/.github/actions/nx-release-version@main
  - if: steps.version.outputs.version != '' && steps.version.outputs.tagged == 'false'
    uses: JanuaryLabs/zukhruf/.github/actions/release-tag@main
    with:
      version: ${{ steps.version.outputs.version }}
```

| Input     | Meaning                                                   |
| --------- | --------------------------------------------------------- |
| `version` | The version that `nx-release-version` wrote, as `0.8.72`. |

Skip the action when `nx-release-version` says `tagged: 'true'`: the tag is there. Pin `@main`, as with `setup-workspace`.
