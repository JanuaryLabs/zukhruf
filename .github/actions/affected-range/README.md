# affected-range

Sets `NX_BASE` and `NX_HEAD` for `nx affected`. The base is the newer of two commits:

- the commit of the last successful run of a workflow, which [`nrwl/nx-set-shas`](https://github.com/nrwl/nx-set-shas) finds
- the commit of the newest `release/*` tag that HEAD reaches

A release commit changes every `package.json` and gets no CI run, so a base before it would mark every project affected. With neither commit, as on a first run, the base is the empty tree: every file differs, so every project is affected and the workflow needs no second command for that case.

The tag is a base only when the repository releases a commit after CI passed for it. A repository that releases each push before CI passes, as zukhruf does ([ADR 0007](../../../docs/adr/0007-release-does-not-wait-for-ci.md)), gives `tested-tags: ''`. Otherwise a tag on an untested commit moves the base past the commits that CI did not test yet, and CI never checks them:

```yaml
- uses: JanuaryLabs/zukhruf/.github/actions/affected-range@main
  with:
    tested-tags: ''
```

```yaml
permissions:
  actions: read # nx-set-shas reads the workflow's runs
  contents: read
steps:
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0
  - uses: JanuaryLabs/zukhruf/.github/actions/setup-workspace@main
  - uses: JanuaryLabs/zukhruf/.github/actions/affected-range@main
  - run: npx nx affected -t lint typecheck test build
```

A deploy that CI starts takes the base from its own last successful run, so a change whose rollout failed stays affected until a rollout succeeds:

```yaml
- uses: JanuaryLabs/zukhruf/.github/actions/affected-range@main
  with:
    workflow-id: deploy.yml
    last-successful-event: workflow_run
```

| Input                   | Default     | Meaning                                                                                     |
| ----------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `workflow-id`           | `''`        | The workflow file whose last successful run is a base; empty means this.                    |
| `last-successful-event` | `push`      | The event of that run.                                                                      |
| `tested-tags`           | `release/*` | The `git describe --match` pattern of the tags on commits that CI passed; empty means none. |

| Output | Meaning                                      |
| ------ | -------------------------------------------- |
| `base` | The commit, or the empty tree, of `NX_BASE`. |
| `head` | The checked-out commit, as `NX_HEAD`.        |

The checkout needs `fetch-depth: 0`, so that the tags and the history are there. [`range.sh`](range.sh) also runs on its own: `sh range.sh [last-green-commit] [tested-tags]`. Pin `@main`, as with `setup-workspace`.
