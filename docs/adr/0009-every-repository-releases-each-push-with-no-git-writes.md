# Every repository releases each push with no git writes

zukhruf released without git writes from 22080c22 ([ADR 0008](./0008-the-release-writes-no-commit-and-tags-the-pushed-commit.md)), and its first two releases ran in 2 min 39 s and 2 min 47 s, against 13 and 17 minutes before. deepagents, sdk-it and elt still released after a green CI run: `tested-commit` skipped a release when `main` had moved past the tested commit, and `nx release version` committed `chore(release): publish <version>` on top of it, tagged that commit and pushed both, so every session pulled the bot commit before its next push.

## Decision

The maintainer chose on 2026-11-22 that the three repositories follow zukhruf once its first two releases without git writes were green ("All three follow"), and that their release starts at the push: "I want the path where release reach npm asap".

- The release steps of ADR 0008 are two shared actions: `.github/actions/nx-release-version` (the version in the checkout of the runner only; the version of a tag that already names HEAD on a re-run) and `.github/actions/release-tag` (the tag `release/<version>` on the pushed commit, through the GitHub API, before the publish). zukhruf, deepagents (32cc215a), elt (2ad93ead) and sdk-it (2ba5ffda) compose their release workflows from them and from `nx-release-publish`.
- Each release workflow runs `on: push` to `main` and does not wait for CI, as ADR 0007 decided for zukhruf. CI only reports, and each `affected-range` gives `tested-tags: ''`.
- `@zukhruf/nx/release.json` writes no git (`version.git` commit, tag and push `false`, 74bfabd7), the same switches that `nx-release-version` passes: no repository relies on the old `true` any more.
- `tested-commit` no longer accepts a release commit on top of the tested commit: no repository makes one. It stays for deploys that run after CI.

## Considered Options

- **Keep the CI gate in the three repositories.** A release would still wait about 20 to 30 minutes for CI, with no skip and no bot commit. The maintainer chose the fastest path to npm instead.
- **Inline steps in each workflow.** Four repositories would hold the same version and tag logic (the Rule of Three).

## Consequences

- A push reaches npm in about 3 minutes plus the propagation of npm in all four repositories: deepagents 7.17.0 ran 2 min 39 s, zukhruf 0.8.73 2 min 45 s.
- No repository gets release commits, so no session pulls one before a push, and the versions in each `package.json` on `main` stay at the last release that committed them. A consumer reads the published version with `npm view`.
- A change that fails CI can reach npm in the three repositories too, and the next push fixes forward.
- A repository switches with one commit, pushed while no Release run of it is in progress and after it holds its newest tag. deepagents and sdk-it pushed the switch while the CI of a `feat` still ran, so the old release never started, and the switch commit's own run released that `feat`.
