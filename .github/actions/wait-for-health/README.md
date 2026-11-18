# wait-for-health

Polls a health URL until it answers 200. Given a commit, a 200 counts only when the body holds `"sha":"<sha>"`, so the check cannot pass against the container that a rollout is replacing.

```yaml
- uses: JanuaryLabs/zukhruf/.github/actions/wait-for-health@main
  with:
    url: https://app.example.com/api/healthz
    sha: ${{ github.sha }}
```

| Input           | Default | Meaning                                   |
| --------------- | ------- | ----------------------------------------- |
| `url`           |         | The health URL.                           |
| `sha`           | `''`    | The commit the body must report as `sha`. |
| `attempts`      | `30`    | How many times to ask.                    |
| `delay-seconds` | `10`    | The wait between two attempts.            |

Pin `@main`, as with `setup-workspace`. [`wait-for-health.sh`](wait-for-health.sh) also runs on its own: `sh wait-for-health.sh <url> [sha] [attempts] [delay-seconds]`.
