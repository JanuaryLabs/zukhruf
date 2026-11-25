# A tsconfig type-checks every generated .ts file, and typed lint has no default project

Status: Accepted 2026-11-25 (backlog #5649).

Decision-makers: the session that fixed #5649, from the shape that zukhruf (29b534fa, #4449) and deepagents (391f2b2e) already have by hand.

`init`, `node-app` and `prisma` gave three files to the default project of typed lint with `allowDefaultProject`: `*.config.ts` and `.husky/*.ts` at the root, `sdk-it.config.ts` of a backend, and `prisma.config.ts` of a db package. No tsconfig included them, so:

- `tsc` never type-checked them. In meddit, `packages/db/scripts/rxnav-concepts.ts` had a type error that only lint reported (Meddit #5593).
- The `typecheck` target did not hash them. `@nx/js/typescript` builds the inputs of `typecheck` from the tsconfigs that the project's `tsconfig.json` references. The plan of `@acme/db:typecheck` listed `packages/db/src/**/*.ts` and no `prisma.config.ts`.
- typescript-eslint gives a file of the default project the root compiler options, and caps the default project at 8 files (`DEFAULT_PROJECT_MATCHED_FILES_THRESHOLD`).

## Decision

1. **`.husky` is the Nx project `hooks`.** `init` writes `.husky/project.json` and `.husky/tsconfig.json` (`include: ["*.ts"]`, output in `out-tsc`), and the root `tsconfig.json` references `./.husky`. The hooks get `typecheck` and `lint` from the plugins of `init`. zukhruf's `.husky` writes to `dist`; the generated one writes to `out-tsc`, as every generated tsconfig that only type-checks does.
2. **`node-app` and `prisma` write `tsconfig.scripts.json`**, a type-check-only tsconfig that includes `sdk-it.config.ts` or `prisma.config.ts`, with output in `out-tsc/scripts`. The project's `tsconfig.json` references it. No project gets both: `prisma` writes a separate db package, and wires a backend without writing its tsconfigs.
3. **No generated eslint config has `allowDefaultProject`.** The root `*.config.ts` glob matched no file that a generator writes; zukhruf's root has no such file and no such block.
4. **The `type-check-config-files` migration of 0.8.116 brings the change to a repo that ran the generators before** (ADR 0017). A node-app or db package with no `tsconfig.scripts.json` gets the one `node-app` or `prisma` writes (their `scriptsTsconfig`), and its `tsconfig.json` gets the reference. `.ts` hooks with no `.husky/project.json` get `hooksProjectJson` and `hooksTsconfig` of `init`, and the root `tsconfig.json` gets the references of `tsconfigSolution`; a `.husky/project.json` that is there stays, whatever its name. An `allowDefaultProject` block is deleted only when it is the one a generator wrote up to 0.8.115 (compared with no whitespace and no trailing commas, so a block that Prettier wrapped still matches) and a tsconfig now covers each of its files. typescript-eslint refuses a file that both a tsconfig and `allowDefaultProject` cover ("was included by allowDefaultProject but also was found in the project service", `useProgramFromProjectService.js`), so a file that a block which stays names gets no tsconfig, and one log names both edits (ADR 0017 decision 5): a block that no generator wrote always stays, and the generated root block stays while a root `*.config.ts` exists, since the root is no project.

This replaces ADR 0010 decision 6 for the sdk-it `allowDefaultProject`, and ADR 0012 decision 14.

## Considered Options

- **Keep `allowDefaultProject`.** Not selected: `tsc` and the `typecheck` hash miss the files.
- **One root tsconfig for every config file.** Not selected: the root is not a project, so no `typecheck` target reads it, and a file gets compiler options from outside its project.

## Consequences

- A dry run on 2026-11-25 (the migration on an `FsTree` of each repo, no flush): meddit gets no change and no log, because it has the change by hand (its 3b389d6 and d48578e). factory and whatisgoingon get no change: each root eslint config has a hand-written block that names `.husky/*.ts` and their `sdk-it.config.ts` (factory also `packages/*/*/prisma.config.ts`), so the migration logs, for each project and for the hooks, the entry to delete and the files to write, and logs the hand-written block. After the entries are deleted, a second run of the migration writes the files.
- A script a repo adds beside `prisma.config.ts` goes into `tsconfig.scripts.json` by hand, with its references. `@nx/js:typescript-sync` has the option `runtimeTsConfigFileNames` (`sync.generatorOptions['@nx/js:typescript-sync']` in nx.json), and `tsconfig.scripts.json` in it does get a missing reference. It is not used: the sync gives each runtime tsconfig a reference for every dependency of the project (nx 24.0.6, `typescript-sync.js:137-144`), and `updateTsConfigReferences` first picks the dependency's tsconfig of the same name (`:252-258`). A backend's `tsconfig.scripts.json` then references the db package's `tsconfig.scripts.json`, not its `tsconfig.lib.json`, and an import of the db package fails with `TS2307` (tried with `tsc`). The generators keep the references of `tsconfig.scripts.json` as they write them.

## Confirmation

- `src/generators/init/generator.test.ts`, `node-app/generator.test.ts` and `prisma/generator.test.ts` check the new files, the references and the eslint configs with no `allowDefaultProject`. Against the generators before this change, 6 of 6 failed (`Cannot find .husky/project.json`, `Cannot find apps/backend/tsconfig.scripts.json`, the `allowDefaultProject` blocks).
- `src/generators/generated-sources.test.ts` writes the generated workspace to a temp folder. The plan of each `typecheck` (`@acme/db`, `@acme/backend`, `hooks`) holds its config file, and the target fails with `TS2322` on a type error in it. Against the generators before this change, it failed: the plan of `@acme/db:typecheck` held no `prisma.config.ts`.
- The same test runs ESLint on each config file and finds no parse error. With the `tsconfig.scripts.json` reference or `.husky/tsconfig.json` removed in memory, each of the 3 cases failed with "was not found by the project service".
- `src/migrations/update-0-8-116/type-check-config-files.test.ts`: a repo that the generators of 0.8.115 wrote (today's output with the `allowDefaultProject` blocks that `init/files.ts`, `node-app/files.ts` and `prisma/files.ts` wrote before this change, no scripts tsconfigs and no hooks project) gets exactly today's output; a second run writes and logs nothing; a hand-written block stays and is logged, and the files it names get no tsconfig; a `.husky/project.json` of another name, a `.husky/tsconfig.json` and a `tsconfig.scripts.json` written by hand stay. Against a migration that does nothing, 5 of the first 6 failed (a second run of one that does nothing writes nothing); seven breaks put in memory each failed a test.
