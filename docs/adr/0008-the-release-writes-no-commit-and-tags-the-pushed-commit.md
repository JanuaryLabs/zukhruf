# The release writes no commit and tags the pushed commit

Superseded in part on 2026-11-22 (#4985) for `@zukhruf/nx/release.json`. It writes no git now, and deepagents, sdk-it and elt release this way too ([ADR 0009](./0009-every-repository-releases-each-push-with-no-git-writes.md)).

Until 2026-11-22, the release committed the versions on top of the pushed commit, pushed the tag of that commit, and merged it into `main` ([ADR 0007](./0007-release-does-not-wait-for-ci.md)). A push took 10 to 14 minutes to reach npm, and 17 minutes when it waited behind another release (the run of 15d7a454, 2026-11-22):

- The tag push ran the pre-push hook on the runner, which built 49 projects with an empty Nx cache: 2.6 to 3.6 minutes.
- The merge into `main` ran the same hook again: 5 to 7 minutes.
- The next push waited behind both.

Each release also changed each `package.json` and the lockfile, so the Nx cache missed every task after a release (#3271), and the release merges conflicted with the lockfile of a peer session twice on 2026-11-22.

No reader needs the versions in git. npm gets the versions that the runner writes. A consumer reads npm. The test gate of `AGENTS.md` and `.github/actions/affected-range` read the release tags, not the versions in a `package.json`.

## Decision

The maintainer rejected two patches that kept the release commit (a bot push with `--no-verify`, and a hook that skips a commit that changes only versions): "I feel both options are wrong. let us employ elon musk first principle thinking". He approved this design on 2026-11-22.

- The release writes no commit to `main`. `nx release version` writes the versions into the checkout of the runner only, and makes no commit, no tag and no push. The release job passes `gitCommit`, `gitTag`, `gitPush` and `stageChanges` as `false` to `releaseVersion`. The `package.json` files on `main` keep the versions that they had on 2026-11-22.
- The release tag `release/<version>` names the pushed commit. The release job makes it with the GitHub API (`gh api --method POST repos/<repository>/git/refs`, with `GITHUB_TOKEN` and `contents: write`), before the publish. The release pushes nothing with git, runs no pre-push hook and makes no new git object. The next release counts its commits from this tag.
- Nx reads the current version from the newest release tag, because `version.conventionalCommits: true` sets the `git-tag` resolver (nx 24.0.6, `config.js`). `nx.json` and `@zukhruf/nx/release.json` do not change.
- When a release tag already names the pushed commit, a run of this commit made the tag and stopped before the end (#4692). A new run of the commit writes the version of that tag again and publishes what npm does not have. A commit with nothing to release ends with "nothing to release".
- The `main` job and `.github/actions/push-release-tag` are gone.
- The version and tag steps live in `.github/actions/nx-release-version` and `.github/actions/release-tag`, which deepagents, sdk-it and elt also use (#4985).

## Considered Options

- **A bot push with `--no-verify`.** The tag push and the merge skip the pre-push hook. Rejected: the release commit and the merge stay, with their lockfile churn and their conflicts.
- **The pre-push hook skips a commit that changes only versions.** Rejected for the same reason.
- **The switches in zukhruf's `nx.json`.** Nx's `extends` is a shallow merge (`{...base, ...nxJson}`), so an override of `release.version.git` replaces the whole `release` block of `@zukhruf/nx/release.json`. The switches stay in the release job.
- **The switches in `@zukhruf/nx/release.json`.** deepagents extends that file, and its release runs `npx nx release version` and needs the commit, the tag and the push. A change of the shared file would break the release of deepagents. The maintainer chose on 2026-11-22 that deepagents, sdk-it and elt move to this release after the first two releases of zukhruf with it are green (#4985).
- **No commit, no tag, and no API call.** Nx needs a tag to count the commits since the last release.

## Consequences

- A push reaches npm with no tag push, no pre-push hook on the runner and no merge job.
- A release changes no file in git, so it does not make every project affected in CI (#3271).
- `main` gets no release commit and no release merge. A session does not pull a release before its next push, and a release cannot conflict with the lockfile of a peer.
- The version in a `package.json` on `main` is not the version on npm. `@zukhruf/nx` reads its own version from its `package.json` at run time (`zukhrufVersion`), and the published `package.json` has the release version. A generator that runs from this checkout writes the version that `main` has. `npx nx release version --dry-run` shows the next version, from the newest release tag.
- The release job pushes nothing, so its checkout keeps no credentials, and zizmor's `artipacked` ignore for `release.yml` is gone.
- The first run under this decision failed once. Its commit, 22080c22, did not hold the merge of 0.8.70, the last release of ADR 0007's design, because that merge reached `main` after the push. Nx counted from `release/0.8.69`, the newest tag that the commit held, computed 0.8.70 again, and the tag step stopped with "Reference already exists" (HTTP 422, run 45032600096) before any publish. From the merge on (a0fc6f28), each release tag names a commit of `main`, and each later commit holds it, so the case does not come back. The old job looked up the newest tag on all branches for this case (`releaseTag.checkAllBranchesWhen`).
- When a push changed a workflow while a release ran, GitHub refused the tag of the release commit: `GITHUB_TOKEN` can never change a workflow (run 44790124711, 0.8.46, 2026-11-20), and `push-release-tag` caught that refusal. The tag now names a commit that `main` has. GitHub's list of permissions for `POST /repos/{owner}/{repo}/git/refs` names Contents write and Workflows write, and does not say when it needs Workflows. A user reports that this call with `contents: write` makes a tag that a `git push` of the tag could not make (GitHub community discussion 26164). When GitHub refuses the tag, the step fails, and nothing is published. The Release run of the next push counts from the tag before and releases the same commits. Such a run is red.
