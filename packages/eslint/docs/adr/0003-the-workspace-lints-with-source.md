# The workspace lints itself with the package's source

The zukhruf workspace uses `@zukhruf/eslint` for its own lint. The package's exports point at `dist`. Nx loads the root `eslint.config.mjs` while it builds the project graph, before any build runs. If the config imported the package by name, a fresh clone would have no `dist`, and every `nx` command would fail, including the build that makes `dist`. So the root config imports `packages/eslint/src/index.ts`. Node.js runs the file with its types stripped, because the file is not under `node_modules`.

## Considered Options

- **Import by name, and build first.** This needs a `prepare` build step, a `lint` dependency on `eslint:build`, and a rebuild before the editor sees a rule edit.
- **A custom export condition for the source.** Each process that loads the config would need `--conditions`: the Nx CLI, its daemon, its plugin workers, and the editor's ESLint server. No one setting reaches all of them.
- **A TypeScript config file.** ESLint needs `jiti` or an unstable flag for it, and the import still resolves to `dist`.

## Consequences

`tsconfig.base.json` sets `erasableSyntaxOnly`, so the compiler rejects syntax that Node cannot strip. The published shape still has tests: the composition tests load the package by name, so they run its `dist`.

Later, each export got a `zukhruf` condition that points at the source, for a repo that links the package. The root config still imports the source by its path, for the reason above.
