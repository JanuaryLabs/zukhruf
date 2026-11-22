# nx-release-publish

Publishes what `nx release version` versioned, with npm provenance. When a project fails to publish, as with a Rekor 409 from sigstore, Nx skips its dependents; one more `nx release publish` cannot heal that, because npm still stages the first publish. So the action publishes once more only the projects that the first run did not publish, and one failure cannot leave a version half-published. [`publish.mjs`](publish.mjs) has the details and the upstream issues.

```yaml
permissions:
  contents: write # the job writes the release tag (and, in a repo that commits its versions, the release commit)
  id-token: write # npm provenance
steps:
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

| Input   | Meaning                                                   |
| ------- | --------------------------------------------------------- |
| `token` | The npm token that publishes, given as `NODE_AUTH_TOKEN`. |

`nx.json` must list `release.projects`: the retry publishes those that the first run did not. Pin `@main`, as with `setup-workspace`.
