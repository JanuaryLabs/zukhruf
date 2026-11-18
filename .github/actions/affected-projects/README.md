# affected-projects

Tells whether `nx affected` selects any of the given projects in the range that [`affected-range`](../affected-range) set. A deploy uses it to decide which images to build; CI uses it to decide whether a job runs.

```yaml
- uses: JanuaryLabs/zukhruf/.github/actions/setup-workspace@main
- uses: JanuaryLabs/zukhruf/.github/actions/affected-range@main
- id: backend
  uses: JanuaryLabs/zukhruf/.github/actions/affected-projects@main
  with:
    projects: '@whatisgoingon/backend @whatisgoingon/web'
- if: steps.backend.outputs.affected == 'true'
  run: echo build the image
```

| Input      | Meaning                                                                                 |
| ---------- | --------------------------------------------------------------------------------------- |
| `projects` | The projects to look for, as `nx --projects` takes them, separated by commas or spaces. |

| Output     | Meaning                                                             |
| ---------- | ------------------------------------------------------------------- |
| `affected` | `'true'` when at least one of the projects is affected.             |
| `list`     | The affected projects among them, as a JSON array, such as `["a"]`. |

The action needs the workspace installed and `NX_BASE` and `NX_HEAD` set, and fails without them. Pin `@main`, as with `setup-workspace`.
