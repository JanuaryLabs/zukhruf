# Code copied in this package

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. A fix in one copy is made in the other copy too, and the commit names both files.

## The workspace root gets no targets

**`src/test/plugin.ts` (`root !== '.'`) → `src/format/plugin.ts` (`dirname(file) !== '.'`).**
The workspace root is an Nx project when its `package.json` has an `nx` key or it has a `project.json`, but a plugin area gives it no targets (ADR 0003). The test area leaves out the test files that the root owns. The format area leaves out the root's own config file, so the root gets no `prettier --check .`. A third area that gives targets extracts the rule (backlog #4019).

## The type-check-only tsconfig of a config file outside src

**`src/generators/node-app/files.ts` (`scriptsTsconfig`, `include: ['sdk-it.config.ts']`) → `src/generators/prisma/files.ts` (`scriptsTsconfig`, `include: ['prisma.config.ts']`).**
A node-app and a db package each type-check a config file outside `src` with a `tsconfig.scripts.json` that writes to `out-tsc/scripts` (ADR 0022). The two differ only in the file they include. The `type-check-config-files` migration imports both, so it is no third copy. A third generator that writes one extracts the function, with the file as its parameter (#5649).

**The PATH of a hermetic test environment (test helper).** `toolFolders` and the `PATH` of `workspace` in `src/testing/workspace.ts` are copied in `packages/git-hooks/src/testing/hooked-repository.ts` (its ledger has the entry): the folder of each named program, found with `command -v`, after node's and before /usr/bin and /bin. Until a third place needs it, a fix in one copy goes into the other.
