# SQLite packages share one folder

SQLite drift and SQLite federation were two packages in the context-compiler repository, at commit 2f70c67. Other packages of that repository imported them. Neither package has a concept of context-compiler: each one is a feature of SQLite itself. Thus both packages move to zukhruf, and context-compiler deletes its copies and uses the published packages.

Nothing copied the two packages. Other modules imported them. A move of a module that other modules import is a question of cohesion, and it can occur at any time ([ADR 0001](./0001-zukhruf-is-a-layered-standard-library.md), rule 3). The Rule of Three does not apply, because there are no copies.

The two packages need a home in this workspace. Each other package is a folder directly in `packages/`. More packages about SQLite can come later, so the two packages start a folder for SQLite.

## Decision

A package whose one concept is a feature of SQLite itself lives in `packages/sqlite/<concept>`. Its npm name is `@zukhruf/sqlite-<concept>`, and its Nx project name is `sqlite-<concept>`. npm has no folders, so the name carries `sqlite`.

- SQLite drift is `packages/sqlite/drift`, `@zukhruf/sqlite-drift`, project `sqlite-drift`.
- SQLite federation is `packages/sqlite/federation`, `@zukhruf/sqlite-federation`, project `sqlite-federation`.
- Both packages are in the base layer (`std:base`). They import Node.js only.

A SQLite backend of another concept stays with that concept. The `FileLock` of `fs`, the SQLite lock store of the mutex, and the SQLite backend of the election ([election ADR 0001](../../packages/election/docs/adr/0001-leader-election-is-a-package-and-each-backend-is-a-subclass.md)) use SQLite, but their concept is a lock or an election.

## Considered Options

- **A flat folder, `packages/sqlite-drift`**, as each other package. This works, but the packages about SQLite do not show as one group.
- **One `@zukhruf/sqlite` package, with an import path for each area.** ADR 0001, rule 1, says that a package has one concept. Drift and federation exist without each other, so they are two packages.
- **The `packages/sqlite/` folder.** This option was selected. The standard library of Go also puts its packages in folders by area, for example `database/sql` and `encoding/json`.

## Consequences

- The `workspaces` field of the root `package.json` lists `packages/sqlite/*`.
- A relative path in a package of this folder goes up three levels, for example `../../../tsconfig.base.json`.
- Lint, the Nx targets, CI and the release need no change. They select a project by its tag, or by a glob that also finds a folder in a folder.
