# Dependency-check options follow the linted manifest's project

A bundled app and an unbundled project need different `@nx/dependency-checks` options. A bundled app inlines its workspace imports, so it declares their npm packages and not them. An unbundled project declares only its own imports. Flat config gives a rule one set of options for each file pattern, and a pattern such as `**/package.json` cannot tell the two apart. Limerence and factory each wrote `eslint.depcheck.mjs` to work around this. It used one options entry built from `process.cwd()`, correct under `nx lint`, plus one entry per project with root-relative globs, correct from the workspace root. Root-relative globs match nothing under `nx lint` (ADR 0002), so each run picked one of the two by accident of where it started.

`manifest/dependency-checks` wraps Nx's rule. For each linted `package.json`, it finds the project from the file, reads the project's shape from its build target, and hands Nx's rule a context whose options fit that project. It reads the project from the graph that `nx` caches, which Nx's rule needs too. So the target defaults in `nx.json` and the targets that Nx plugins infer count, as they do for Nx. The repo's options are added to the shared policy, as with the option factories (ADR 0004). Islands keep `island/dependency-checks`, and the new rule skips them, so a finding is never reported twice.

## Considered Options

- **Copy `eslint.depcheck.mjs` into the package.** Its two mechanisms depend on the working directory, which is the problem this package exists to remove.
- **One options entry per project, from the project graph.** It needs Nx's cached graph at config load, which a fresh clone does not have, and the globs are still root-relative.
- **Make `island/dependency-checks` shape-aware for every project.** `island/recommended` would then check non-island manifests, and the name would no longer say what it checks.

## Consequences

- The wrapper has its own option schema (`projects` is not an Nx option) and keeps Nx's `fixable` and messages, so `--fix` still works.
- Nx's rule reads only the project graph that `nx` caches. Without it, the rule checks nothing. The composition tests build a graph in each temporary workspace and assert a finding that must appear.
- An esbuild app without a `bundle` option counts as bundled, because esbuild bundles by default. The copied scripts counted it as unbundled.
- The rule reads the graph when it lints a manifest, not at config load. A fresh clone has no graph then either, and Nx's rule checks nothing without one, so the read adds no new failure.
- An esbuild app that names a workspace package it imports in `external` counts as unbundled, because its build leaves that package to `node_modules`. Nx's rule follows the imports of all workspace packages, or of none. If the rule followed all of them for such an app, it would demand the npm packages of the external ones, and `--fix` would write them into the manifest. So the rule follows none, and it does not check the npm imports of the workspace packages that the app still inlines.
