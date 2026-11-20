# Release does not wait for CI

A push to `main` is a release. Until this decision, `.github/workflows/release.yml` started only after a CI run on `main` passed (`on: workflow_run`). A red or cancelled run released nothing.

The cost was high. On 2026-11-20, the last 60 CI runs on `main` (about 30 hours) gave 33 green, 11 red and 15 cancelled runs, and 8 releases. A green run took 27.7 minutes (median). Sessions pushed every 8.2 minutes (median). One Docker test that failed in one package stopped the release of 40 packages. Seventeen `feat` and `fix` commits waited on `main` after `release/0.8.43`.

Most of what CI checks, a commit has already proved before the push:

- The pre-push hook runs lint, typecheck and build on each pushed commit, in a snapshot.
- The test gate of `AGENTS.md` runs the affected tests before each commit.

Established systems split the checks in the same way:

- **Presubmit and postsubmit.** In trunk-based development, as Google runs it with TAP, fast checks run before a change lands, and the full suite runs after it lands. A red postsubmit run does not stop the trunk. The team fixes forward or rolls back.
- **A deployment pipeline with promotion.** Humble and Farley (_Continuous Delivery_, 2010) build an artifact once, publish it as a release candidate, and let later stages promote the same artifact. On npm, the tool is the dist-tag: publish to `next`, then move `latest`. `typescript@next` and `react@canary` are channels of this kind. This repository promotes images in the same way (`.github/actions/ghcr-promote`).
- **Advisory checks.** GitHub calls a status check that reports and does not gate a check that is not required.

## Decision

The maintainer said on 2026-11-20: "let the release pipeline runs without checking for the test length type check and all this stuff. I still want ci to run but not to block the release anymore."

The maintainer then chose "Advisory only" for a red CI and "Keep the manual gate" for the push.

- `release.yml` runs `on: push` to `main`. It does not wait for CI.
- The release still builds the packages, because it cannot publish a package that does not build. It does not run lint, typecheck or tests.
- The release publishes to `latest`. A red CI run does not change npm. The next push fixes forward.
- The pushes that arrive during a release wait as one pending run, and a newer push replaces it. A release is never cancelled. The newest push releases every commit since the last release. The maintainer said of a release for each commit (#4831): "what is the point of releasing every commit if we have a newer one?"
- CI runs every target on each push to `main`, as before, and only reports. It never cancels a run on `main`, so that each run ends and says whether `main` is green.
- The pre-push hook stays at lint, typecheck and build. The test gate of `AGENTS.md` stays a step that the session runs before the commit.
- `affected-range` takes the base of CI from the last green run only (`tested-tags: ''`). A release tag can now be on a commit that CI did not check. If the tag moved the base, CI would never check the commits before the tag.

## Considered Options

- **Promote on green.** Each push publishes to `next`, and a green CI moves `latest` to that version. npm picks `latest` when it satisfies a range: with `latest` 0.8.44 and `next` 0.8.46, `^0.8.40` gives 0.8.44 and `^0.8.45` gives 0.8.46 (a probe of `npm-pick-manifest`, 2026-11-20). So a consumer stays on a green version until it asks for a newer one. CI must run `npm dist-tag` for this. Trusted publishing allows it as an opt-in since 2026-09-30, and the move to trusted publishing is #4064.
- **Publish to `latest`, and deprecate on red.** A red CI runs `npm deprecate` on the version. This repairs the damage after it occurs, and `npm deprecate` gave E403 on 2026-11-09.
- **The pre-push hook runs the affected tests.** No untested code then reaches npm. Each push takes minutes longer, and the Docker suites run on each push.
- **Advisory only, with the manual test gate.** This option was selected.

## Consequences

- A broken version can reach `latest` on npm. A consumer that installs it gets the fix in the next release.
- The release starts seconds after a push and takes about 5 minutes. A consumer can install the change without a wait for CI.
- A release writes a new version into each `package.json`. Between two CI runs there is now almost always a release, so CI finds every project affected, and the Nx cache misses almost every task. A CI run takes about 25 to 38 minutes. It gates nothing. #3271 records how versions can stay out of git.
- `main` gets a release merge after almost every push that releases. A session pulls that merge before its next push more often.
- Each release publishes about 40 packages. npm gets many more versions.
- The `workflow_run` trigger is gone, so zizmor's `dangerous-triggers` ignore for `release.yml` is gone too.
- The other repositories that use `affected-range` release after green CI. They keep the default `tested-tags: release/*`, and their ranges do not change.
