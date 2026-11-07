# The package is private and is reached through a workspace path

Status: superseded on 2026-11-07. The code of `@zukhruf/structured-eval` is `./structured` of the public `@zukhruf/evals` (its ADR 0001, backlog #3888), so this private exception ended. The ADRs of this folder keep their numbers and their words; a class name that moved is in `src/structured/`.

Workspace ADR 0001, rule 8, says that npm has no private package. This package breaks that rule. Ezz chose a private package on 2026-11-03: the framework is new, and its first consumer is one app.

The first consumer is apps/startup-credits in context-compiler. That repository installs the other @zukhruf packages from npm. It adds the exact folder `../mutex/packages/structured-eval` to its npm workspaces, as it adds the elt packages.

## Considered Options

- Public on npm, as rule 8 says.
- Private, in context-compiler as a @workspace/ package, and moved here later.
- Private here, reached through a workspace path. This option was selected.

## Consequences

- The consumer gives the exact path, not `../mutex/packages/*`. A glob would take every @zukhruf package from this repository in place of the npm copies.
- The consumer cannot fence the @zukhruf scope, because it installs other @zukhruf packages from npm. The scope belongs to us, so the risk is low.
- The consumer reads `dist`. Build the package before you install it there.
- When a second repository needs the package, publish it and delete this exception.
