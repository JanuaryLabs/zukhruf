# Code copied in this package

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. A fix in one copy is made in the other copy too, and the commit names both files.

## The workspace root gets no targets

**`src/test/plugin.ts` (`root !== '.'`) → `src/format/plugin.ts` (`dirname(file) !== '.'`).**
The workspace root is an Nx project when its `package.json` has an `nx` key or it has a `project.json`, but a plugin area gives it no targets (ADR 0003). The test area leaves out the test files that the root owns. The format area leaves out the root's own config file, so the root gets no `prettier --check .`. A third area that gives targets extracts the rule (backlog #4019).

## The portless proxy env

**`src/generators/node-app/generator.ts` (`mergeNodeNxJson`) → `src/generators/react-app/generator.ts` (`mergeReactNxJson`).**
Each app generator writes a `portless` target, so each adds `PORTLESS_UNPRIVILEGED=1` and `PORTLESS_HTTPS=1` to `targetDefaults.portless.options.env` with `addMissingKeys` (#4768). The two copies are the same code, and only their comments differ: each names the HTTPS origin of its own kind of app. A third place that writes the env, such as the `@zukhruf/nx/portless` plugin (#3336), extracts it (backlog #4786).
