# nx-release-publish

Publishes what `nx release version` versioned, with npm provenance. When a project fails to publish, as with a Rekor 409 from sigstore, Nx skips its dependents; one more `nx release publish` cannot heal that, because npm still stages the first publish. So the action publishes once more only the projects that the first run did not publish, and one failure cannot leave a version half-published. [`publish.mjs`](publish.mjs) has the details and the upstream issues.

```yaml
permissions:
  contents: write # nx release version pushes the release commit and tag
  id-token: write # npm provenance
steps:
  - uses: JanuaryLabs/zukhruf/.github/actions/setup-workspace@main
    with:
      registry-url: https://registry.npmjs.org/
  - run: npx nx release version
  - uses: JanuaryLabs/zukhruf/.github/actions/nx-release-publish@main
    with:
      token: ${{ secrets.NPM_ACCESS_TOKEN }}
```

| Input   | Meaning                                                   |
| ------- | --------------------------------------------------------- |
| `token` | The npm token that publishes, given as `NODE_AUTH_TOKEN`. |

`nx.json` must list `release.projects`: the retry publishes those that the first run did not. Pin `@main`, as with `setup-workspace`.
