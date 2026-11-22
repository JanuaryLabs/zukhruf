# tested-commit

Tells a workflow that CI starts (`on: workflow_run`) whether HEAD is still the commit that CI tested. When main moved past it, the newer commit's own run deploys it, and shipping the older one would roll main back. The npm releases of zukhruf, deepagents, sdk-it and elt run on push and do not use it (root ADR 0008).

```yaml
- uses: actions/checkout@v7
  with:
    ref: main
- id: tested
  uses: JanuaryLabs/zukhruf/.github/actions/tested-commit@main
- if: steps.tested.outputs.current == 'true'
  run: ./deploy.sh # the deploy of the tested commit
```

| Input | Default                                     | Meaning                    |
| ----- | ------------------------------------------- | -------------------------- |
| `sha` | `${{ github.event.workflow_run.head_sha }}` | The commit that CI tested. |

| Output    | Meaning                                                             |
| --------- | ------------------------------------------------------------------- |
| `current` | `'true'` when HEAD is the tested commit, `'false'` when main moved. |

The action fails when `sha` is empty, as it is outside a `workflow_run` event. Pin `@main`, as with `setup-workspace`.
