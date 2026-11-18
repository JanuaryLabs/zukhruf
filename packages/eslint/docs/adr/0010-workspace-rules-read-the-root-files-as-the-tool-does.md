# Workspace rules read the root files as the tool does

Status: Accepted 2026-11-18 by the owner (backlog #4672).

The agent of #3342 left two rules of the monorepo standard as prose ([ADR 0009](./0009-project-config-rules-read-the-file-not-the-graph.md)):

1. The root `package.json` lists each project folder in `workspaces` with single-`*` globs (`apps/*`, `packages/*`) and names a dot folder by its path, never with `**`. npm matches workspaces without `dot`, and a `**` makes a workspace of each untracked folder below it and of each `dist/package.json` that a build writes.
2. `generatePackageJson` of `@nx/esbuild` throws in a TS solution workspace: `normalizeOptions()` of the executor calls `isUsingTsSolutionSetup()` of `@nx/js` and throws "Setting 'generatePackageJson: true' is not supported with the current TypeScript setup". The project's own `package.json` is the deploy manifest, and `prune-lockfile` writes it with the lockfile into the output.

ADR 0009 lets a rule read the linted file and the files of its folder. The second rule also needs three files of the workspace root, which `workspaceRootOf()` already finds for other rules.

## Decision

Both become rules, and each reads what the tool reads.

- **`manifest/no-globstar-workspace`** joins `manifest/recommended`. It reports each entry of a `workspaces` array that has a `**` segment. A `**` inside a segment, as in `tools/**-cli`, matches like `*` and passes. A negated entry (`!…`) takes folders out, so it passes too. The rule checks every `package.json` with a `workspaces` array, because that key makes its folder a workspace root.
- **`zukhruf/no-generate-package-json`** joins the target rules of `nx-project-json`, in `project.json` and in the `nx` key of `package.json`. It reports a truthy `generatePackageJson` in `options` or in a `configurations` entry of a target whose `executor` is `@nx/esbuild:esbuild`, when the workspace is a TS solution one. The rule decides that as `isUsingTsSolutionSetup()` of `@nx/js` 23.2 does, from the root files: `workspaces` in the root `package.json` or `packages` in `pnpm-workspace.yaml`; a `tsconfig.json` that extends `./tsconfig.base.json` and sets `files` or `include`, each only as an empty list; and a `tsconfig.base.json` with `composite`, and `declaration` not `false`. The tsconfigs are read with comments, as TypeScript allows.

## Considered Options

- **Check that `workspaces` lists every project folder.** A walk of the tree from the root sees the untracked folders and the `dist/package.json` copies too, so it would report the folders that the rule keeps out. Only Git knows which folders are tracked. The rule checks the globs, not the coverage.
- **Call `isUsingTsSolutionSetup()` of `@nx/js`.** It sits in `@nx/js/internal`, which this package does not depend on, and without a tree it reads the root from the process's working folder, not from the linted file. The rule copies its four conditions, and the comment names the version they come from.
- **Read `references` of the root `tsconfig.json`.** Nx does not read them: a new workspace with no project has no references and is a TS solution one already.
- **Follow Nx's choice of package manager.** Nx reads `workspaces` for npm and yarn and `pnpm-workspace.yaml` for pnpm, and picks the package manager from `nx.json` `cli.packageManager`, the lockfile or the `npm_config_user_agent` of the process. The rule accepts either file. It differs from Nx only for a root whose one workspaces file belongs to the package manager that Nx did not pick, such as a `pnpm-workspace.yaml` beside a `package-lock.json`. The standard uses npm.
- **Report `generatePackageJson` of a target with no `executor`.** A target default in `nx.json` can give it `@nx/esbuild:esbuild`, and only the project graph shows that. A target default of `@nx/esbuild:esbuild` in `nx.json` is not checked either, because the rules do not lint `nx.json`.

## Consequences

A repo whose `workspaces` uses `**` gets an error on upgrade, and so does a TS solution repo whose esbuild target still sets `generatePackageJson`; its build already throws. zukhruf has neither: its globs are single-`*`, and it has no `@nx/esbuild` target.
