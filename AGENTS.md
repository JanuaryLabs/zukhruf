# zukhruf

## Work in the one checkout

Every session shares this checkout. Do not make a git worktree, a `git clone` (also a clone by URL), an exported tree or any other copy of the repository, not even to gate a commit or run a live check. Build and test here. A copy proves the copy, not what ships: its installed packages, its nx cache and its project graph differ from this checkout ([git-hooks ADR 0002](packages/git-hooks/docs/adr/0002-a-pre-push-step-builds-the-pushed-commit-in-a-snapshot.md), Evidence). The pre-push hook builds each pushed commit in a snapshot, so a push proves the commits that it sends.

Never leave anything staged in the shared `.git/index`: a peer's plain `git commit` takes all of it. Commit whole files with `git commit --only -m <msg> -- <paths>`; for a new file, run `git add -- <new> && git commit --only -m <msg> -- <paths>` as one command. To commit only your hunks of a file that a peer also edits, use a private index: run `GIT_INDEX_FILE=<scratchpad>/index git read-tree HEAD`, then stage your hunks with `git apply --cached`, read them with `git diff --cached -U3` and commit, each with the same `GIT_INDEX_FILE`. Then set the shared index to the new HEAD for those paths with `git diff --cached -R --binary -- <paths> | git apply --cached`. After each commit, check that `git diff --cached --name-only` prints nothing and that `git show --stat HEAD` lists only your paths.

When a peer's unfinished work breaks a test, ask that peer; do not copy the tree to get around it.

Other sessions build from this checkout, so work that does not compile yet stays a patch file outside the repository. Apply it here when it compiles, and commit it at once.

## A commit is a release

The next push from any session sends every local commit to `main`, and a green CI run on `main` releases it. Thus the gates run before the commit, not before the push. Run them here:

- `npm install --package-lock-only --ignore-scripts` changes no line of `package-lock.json`. This stands in for `npm ci`.
- `npx nx sync:check`
- `npx prettier --check .`
- `npx nx affected -t lint typecheck test build --base=<tag> --head=HEAD`, where `<tag>` is the last release tag: `git for-each-ref --sort=-creatordate --count=1 --format='%(refname:short)' 'refs/tags/release/*'`. CI compares with the same tag.

A project tagged `platform:darwin` runs its targets on a macOS runner in CI ([root ADR 0005](docs/adr/0005-a-project-that-needs-macos-runs-its-targets-on-a-macos-runner.md)). On this Mac, its tests run here like the others.
