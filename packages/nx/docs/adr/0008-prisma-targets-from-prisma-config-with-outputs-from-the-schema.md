# An inference plugin gives each Prisma project its targets, with the outputs that the schema names

Status: Proposed 2026-11-18 for the owner's review (backlog #3339).

Six projects copy a cached `generate` target: `@factory/db` of factory, and `v2-db`, `authx-db`, `desktop-db`, `db` and `@workspace/amail` of text2sql. Five of them also copy `migrate` and `deploy`, and four copy `reset` and `pull`. meddit adds a seventh project. The owner put the area in scope on 2026-11-18 with these words: "detect a prisma schema / prisma.config.ts; cached generate (inputs models/\*\*/\*.prisma), migrate (migrate dev), deploy (migrate deploy), reset, pull; typecheck/build dependsOn generate".

The copies are the same in the commands and in `cwd: "{projectRoot}"`. They are different in these parts:

- The outputs of `generate`: `src/prisma` in 5 projects, `prisma/client` in amail. Each one is the `output` of the `generator` block in the schema.
- The inputs: `models/**/*.prisma` in 4 projects; each copy also has the whole `package-lock.json`.
- The dependencies: `migrate` depends on `generate` in factory, and on `build` in text2sql. factory adds `generate` to `typecheck` in the project; text2sql adds it with a tag filter in `targetDefaults`.

## Decision

The `prisma` area of `@zukhruf/nx` gives `generate`, `migrate`, `deploy`, `reset` and `pull` to each project root with a `prisma.config.ts`. It takes no options.

- The inputs of `generate` are `{projectRoot}/**/*.prisma`, `{projectRoot}/prisma.config.ts` and `externalDependencies` on `prisma` and `@prisma/client`. An update of another package does not run `generate` again.
- The outputs of `generate` are the `output` folders of the `generator` blocks in the `*.prisma` files of the project, each relative to its file, as Prisma reads it. When a block has no `output`, Prisma writes into `node_modules`, and `generate` has no cache.
- `migrate` depends on `generate`.
- The plugin does not change `typecheck` or `build`. A workspace adds `generate` to their `dependsOn` in `targetDefaults`, as it adds `format:check` ([ADR 0001](./0001-inferred-targets-not-copied-defaults.md)). Nx skips a dependency on a target that the project does not have, so one line serves each project.

## Considered Options

- **The plugin adds `generate` to `typecheck` and `build`.** REJECTED for now. Those targets belong to `@nx/js/typescript` and to the project, and a later source replaces a `dependsOn` with no `"..."`. ADR 0001 rejected the same change for `format:check`. The owner's words ask for the dependency; this ADR gives it through `targetDefaults` and asks the owner to confirm.
- **An option for the output folder.** REJECTED. The folder is different in each project of one workspace, and the schema already names it.
- **`package-lock.json` as an input, as in the copies.** REJECTED. Each update of any package runs `generate` again. `externalDependencies` hashes the Prisma packages and the packages that they reach.
- **The target `prisma` of text2sql, which runs the CLI with any arguments.** Not in the scope of #3339. It stays in each project that wants it.

## Consequences

A workspace lists `@zukhruf/nx/prisma`, adds `generate` to `targetDefaults.typecheck.dependsOn` and `targetDefaults.build.dependsOn`, and deletes the copied targets and the `typecheck:generate` tag. `prisma` and `@prisma/client` must be in the lockfile, or the hash of `generate` stops with an error.
