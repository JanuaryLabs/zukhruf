# Project configuration rules read the file, not the graph

The monorepo standard of `@zukhruf/nx` kept six rules as prose (#3342): a target with `options.command` and no executor, `paths` aliases between projects, a `dependsOn` on a named project, root npm scripts other than `prepare`, the same key in a `project.json` and in the `nx` key of a `package.json`, and an ESLint config that reads the project graph when it loads. Five of them became rules. Each rule decides from the linted file, and at most from the files of its folder, never from Nx's cached project graph.

## Decisions

- **Homes follow the file.** The target rules (`no-missing-command-executor`, `no-depends-on-project`) join `nx-project-json`, which now has a second block for the `nx` key of `package.json`: a target there is the same Nx target. `no-duplicate-nx-key` reads both files of a folder and reports in the `project.json`, so it runs only there. `no-cross-project-paths` is the first rule of a new concept, `tsconfig`, because a tsconfig is not an Nx file. `no-root-script` checks a manifest, so it joins `manifest/recommended`. The config keeps its name `nx-project-json`: a new name would break each consumer that extends it.
- **A policy, not a resolution.** `no-missing-command-executor` asks for `executor` in the target that sets `options.command`. A target default in `nx.json` or a target that a plugin infers can give an executor, and only the graph shows that. The graph is missing on a fresh clone, and a rule that reads it checks nothing there. The fix, `"executor": "nx:run-commands"`, also merges with an inferred target, so the policy costs one line where the graph would have passed.
- **Report only what the file can tell.** `no-depends-on-project` reports an object with `projects`, and not the string `"<project>:<target>"`. Nx reads that string as a project only when the first segment is a project name; otherwise the whole string is a target name, such as `format:check` in zukhruf's `nx.json`. The file cannot tell the two apart.
- **A project is a folder with a manifest.** `no-cross-project-paths` finds the project of the tsconfig and of each alias target as the island rules do ([ADR 0002](./0002-scope-from-the-linted-file.md)): the nearest folder with a `project.json` or a `package.json`. A target under `node_modules` is a package, not a project of the workspace, and passes.
- **A root is a real workspace root.** `no-root-script` checks only a `package.json` whose folder `workspaceRootOf()` finds as the root. `nx-family-pinned` treats a manifest outside any workspace as a root; a lone package has no Nx targets to move its scripts to, so this rule leaves it alone.

## Left out

- **An ESLint config that reads the project graph when it loads.** This is a check of JavaScript, not of a JSON file. The ways to read the graph are an open list: `readCachedProjectGraph()` and `createProjectGraphAsync()` of `@nx/devkit`, a deep import of `nx/src/…`, `nx graph --file` in a child process, or a read of `.nx/workspace-data/project-graph.json`. A ban of the names that are known today would pass the rest. It stays prose until a rule can name what it checks.

## Consequences

A consumer that extends `zukhruf/nx-project-json` now also lints the `nx` key of each `package.json`, and a consumer that extends `manifest/recommended` lints its root scripts. Repos with root scripts, `paths` aliases between projects or named `dependsOn` projects get errors on upgrade, and each repo fixes them in its own change.
