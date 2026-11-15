# A project that needs macOS runs its targets on a macOS runner

CI is one job on `ubuntu-latest` (`.github/workflows/ci.yml`, job `ci`). It runs `npx nx affected -t lint typecheck test test-network build` for each project that a change can break. CI ran on macOS and Windows runners before, and stopped when no test needed them ([testing ADR 0015](../../packages/testing/docs/adr/0015-a-test-that-needs-docker-requires-it.md)).

`@zukhruf/launchd` drives launchd, which exists only on macOS. Its tests cannot run on Linux. Our rules for tests decide what CI must do:

- A test takes the real path. A test of launchd runs the real `launchctl` against a real launchd, with real job files.
- A test that needs a capability requires it, and CI gives the capability. No environment variable turns such a test into a skip, because a skip can hide a broken capability and still give a green run ([testing ADR 0015](../../packages/testing/docs/adr/0015-a-test-that-needs-docker-requires-it.md)).

The leading tools test launchd in these ways (research record for `@zukhruf/launchd`, 2026-11-15):

- nix-darwin runs `darwin-rebuild switch` in CI on `macos-15`.
- Ansible's `community.general.launchd` has an integration target that runs the real `launchctl` on Darwin.
- Puppet stubs `launchctl` in its unit tests, and runs Beaker tests on macOS agents.
- Homebrew puts a fake `launchctl` on the `PATH` and compares golden job files (`cli_spec.rb:990-1008`, `service_spec.rb:536+`). The fake never proves the real race of a bootout: launchd answers 36 until the process is gone, and 3 after that.
- kardianos/service has no tests on Darwin.

## Decision

The maintainer chose on 2026-11-15: "macOS job for darwin projects".

- A project that drives a facility of macOS, such as launchd, has the tag `platform:darwin`.
- The ubuntu job leaves out the tagged projects: `nx affected … --exclude=tag:platform:darwin`.
- A second job on `macos-latest` runs `nx affected` for the tagged projects only: `--projects=tag:platform:darwin`.
- Each target of a tagged project runs in the macOS job: lint, type check, test and build. Thus the tests of a project stay in one place, and they are never split between two jobs.

## Considered Options

- **A fake `launchctl`, as Homebrew.** The tests then prove the fake. They do not prove the answers of launchd: 36 and 3 of a bootout, 113 of `print`, the job files that launchd accepts, and the lines of `print` that change with macOS.
- **The real tests only on the Mac of a developer.** CI never runs them, and a green CI says nothing about the project. That is a split by the operating system under another name.
- **A macOS job for the projects that need macOS.** This option was selected.

## Consequences

- The change of the workflow ships in the same push as the first tagged project. Without the exclusion, the ubuntu job runs the tests of the project, and they fail. Without the macOS job, CI never tests it.
- macOS minutes cost nothing on a public repository.
- The macOS job runs on each new image of the runner. A change of `launchctl` in a new macOS fails a test there first ([launchd ADR 0006](../../packages/launchd/docs/adr/0006-the-state-of-one-service-comes-from-print-and-only-two-of-its-lines.md)).
- A developer on Linux or Windows sees the tests of a tagged project fail with `LaunchdUnavailableError`. Run them on a Mac, or leave out the tag as CI does.
- A project that works on each system does not get the tag. The tag is for a project that cannot run its tests anywhere but on macOS.
