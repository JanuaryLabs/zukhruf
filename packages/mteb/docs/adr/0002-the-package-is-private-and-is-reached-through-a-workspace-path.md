# The package is private and is reached through a workspace path

Status: Accepted 2026-11-07 by Ezz.

Workspace ADR 0001, rule 8, says that npm has no private package. This package breaks that rule. It is a recorded exception.

The `package.json` of the package gave two answers. It had `"private": true`, so Nx tags it `npm:private` and the release skips it. It also had `publishConfig.access: public`, which only a published package reads. Ezz chose a private package on 2026-11-07 (backlog #3935). Thus `publishConfig` goes, and `"private": true` stays.

A project of this workspace reaches the package through its path: it names `@zukhruf/mteb` in its dependencies with `"*"`, and npm links the workspace package. A repository outside this workspace gives the exact path of the package in its workspaces, as for `@zukhruf/structured-eval`.

## Considered Options

- Public on npm, as rule 8 says. Then its dependencies on @zukhruf packages change from `"*"` to `^<version>`.
- Private, reached through a workspace path. This option was selected.

## Consequences

- The package takes its @zukhruf dependencies (`async`, `python`, `random`, `statistics`, `testing`) with `"*"`, as each private package does (backlog #3439).
- A consumer reads `dist`. Build the package before a consumer uses it.
- When the package must be used outside these repositories, publish it and delete this exception.
