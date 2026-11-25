# macOS packages share one folder and keep their names

Status: Accepted 2026-11-26 (backlog #5747).

Decision-makers: the maintainer, on the folder ("when I said packages/macos I meant macos as container folder for all upcoming macos packages"), on the names ("don't publish it as @zukhruf/macos-\* — we prefix by platform/tool only to give it namespace") and on the move of launchd (he chose to move it, 2026-11-26); the context-compiler session context-compiler-99 on the rest, after ADR 0003.

A second package that works only on macOS is coming: `@zukhruf/tcc` tells a process which privacy grants of macOS it has and what the user must turn on ([tcc README](../../packages/macos/tcc/README.md)). `@zukhruf/launchd` was the first one, in `packages/launchd`. The maintainer wants one folder for the macOS packages: "when I said packages/macos I meant macos as container folder for all upcoming macos packages" (2026-11-26).

The names need a rule too. [ADR 0002](./0002-sqlite-packages-share-one-folder.md) gives the SQLite packages the prefix `sqlite-`, because "open" or "drift" alone is not clear. [ADR 0003](./0003-information-filtering-packages-share-one-folder-and-keep-their-names.md) keeps the names of the information-filtering packages, because the name of each stage is clear alone. The maintainer chose the rule of ADR 0003 for macOS: "don't publish it as @zukhruf/macos-\* — we prefix by platform/tool only to give it namespace" (2026-11-26). The names of the macOS packages are names of Apple subsystems: launchd is the service manager, launchd(8). TCC is the subsystem of Transparency, Consent, and Control, with its daemon `tccd` and its tool tccutil(1). Each name is clear alone.

## Decision

A package that works only on macOS lives in `packages/macos/<name>`. Its npm name is `@zukhruf/<name>`, and its Nx project name is `<name>`, with no prefix for the platform.

- `@zukhruf/launchd` moves from `packages/launchd` to `packages/macos/launchd`. Its npm name, its Nx project name and its tags do not change.
- `@zukhruf/tcc` is `packages/macos/tcc`, project `tcc`.
- Each package has the tag `platform:darwin`, so the darwin job of CI runs its targets ([ADR 0005](./0005-a-project-that-needs-macos-runs-its-targets-on-a-macos-runner.md)).

A name takes a prefix only when the name alone is not clear, as in ADR 0002.

## Considered Options

- **A flat folder for each package**, as `packages/launchd` is now. This works, but the macOS packages do not show as one group.
- **The folder and the prefix of ADR 0002, `@zukhruf/macos-tcc`.** The maintainer refused it: a prefix only gives a namespace to a name that needs one.
- **The folder, and the name of the Apple subsystem.** This option was selected.

## Consequences

- The `workspaces` field of the root `package.json` lists `packages/macos/*`.
- A relative path in a package of this folder goes up three levels, for example `../../../tsconfig.base.json`. The move of launchd changes its relative paths and nothing else.
- Lint, the Nx targets, CI and the release select a project by its tag, or by a glob that also finds a folder in a folder, so they need no change.
- The consumers of `@zukhruf/launchd` see no change: npm has no folders.

## Confirmation

- The move of `packages/launchd` to `packages/macos/launchd` changes only relative paths: each `../` in its Markdown links and tsconfig files gains one `../`, and `project.json` names the new `sourceRoot`. `npm install` moved one lockfile entry, `packages/launchd` to `packages/macos/launchd`, and changed no version.
- `npx nx run launchd:typecheck` passes, and `npx nx run launchd:test` passes 38 of 38 tests against the real `launchctl` on macOS 27.2 (2026-11-26).
- `npx nx show project launchd --json` gives the root `packages/macos/launchd`, with the same name and tags.
