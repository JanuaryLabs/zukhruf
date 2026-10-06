# A rule finds its scope from the linted file

`nx lint` runs ESLint from the project folder. When a project's own config re-exports the root config, ESLint resolves the root's `files` globs from the project folder, and a glob such as `apps/**` matches nothing. In Limerence, the `no-console` and import bans for `apps/**` never ran under `nx lint`, though they ran in the editor. The copied island config had a second problem: it found the workspace from its own location (`import.meta.dirname`), which is wrong once the config is installed under `node_modules`.

Every glob that the package ships starts with `**`. A rule that applies only to some folders takes them as `roots`, relative to the workspace root. A rule finds the workspace root by walking up from the linted file to the nearest `nx.json`, `pnpm-workspace.yaml`, or `package.json` with `workspaces`. Island rules find the file's project, and its tags, the same way: from the nearest `project.json` or `package.json`.

## Considered Options

- **`basePath` on each config object.** It fixes the globs, but the repo must set it for each block, and the package cannot know the path.
- **Nx's cached project graph for tags.** It does not exist on a fresh clone, so the island config threw under plain `npx eslint`. Reading the manifests works everywhere. The cost: tags that an Nx plugin infers are not seen, and `layer:island` is always declared in a manifest.

## Consequences

The editor and `nx lint` apply the same rules to a file. A test lints a temporary workspace from a project folder whose config re-exports the root config, and checks that `roots` and `settings.island.libraries` still apply.
