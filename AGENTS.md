# zukhruf

## A commit is a release

The next push from any session sends every local commit to `main`, and a green CI run on `main` releases it. Thus the gates run before the commit, not before the push. Run them here:

- `npm install --package-lock-only --ignore-scripts` changes no line of `package-lock.json`. This stands in for `npm ci`.
- `npx nx sync:check`
- `npx prettier --check .`
- `npx nx affected -t lint typecheck test build --base=<tag> --head=HEAD`, where `<tag>` is the last release tag: `git for-each-ref --sort=-creatordate --count=1 --format='%(refname:short)' 'refs/tags/release/*'`. CI compares with the same tag.

A project tagged `platform:darwin` runs its targets on a macOS runner in CI ([root ADR 0005](docs/adr/0005-a-project-that-needs-macos-runs-its-targets-on-a-macos-runner.md)). On this Mac, its tests run here like the others.
