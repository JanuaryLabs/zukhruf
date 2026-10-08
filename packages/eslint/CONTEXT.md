# ESLint

The shared lint rules of several repos, packaged once. A repo picks configs by name and gives its own values as options. The package never takes a rule key that a repo fills with its own entries.

## Language

### Rules and configs

**Check**:
One thing the package enforces, such as "no enums". Each check is its own rule, under its own key.
_Avoid_: Restriction, selector entry

**Concept**:
One concern the package lints, such as React Router links or Tailwind classes. A concept has rules and one config that turns them on.
_Avoid_: Category, preset

**Config**:
A named flat-config array that the plugin ships, such as `zukhruf/base`. A repo uses it with `extends: ['zukhruf/base']`.
_Avoid_: Preset, profile

**Repo-owned rule**:
A rule whose options are one list that each repo fills with its own entries: `no-restricted-syntax`, `no-restricted-imports`, `@typescript-eslint/no-restricted-imports`. The package never sets these rules.
_Avoid_: Shared rule

**Option factory**:
A function that returns a rule's complete options, with a repo's entries added to the shared ones. Examples are `noLet()`, `dependencyPolicy()` and `moduleBoundaries()`.
_Avoid_: Options helper, builder

### Where a rule applies

**Workspace root**:
The nearest folder at or above the linted file that has `nx.json`, `pnpm-workspace.yaml`, or a `package.json` that declares `workspaces`.
_Avoid_: Repo root, cwd

**Roots**:
A rule option: folders relative to the workspace root where the rule applies. An empty list means everywhere.
_Avoid_: Paths, scope globs

**Project**:
The nearest folder at or above the linted file that has a `project.json` or a `package.json`, with the tags those files declare.
_Avoid_: Package (when tags matter)

### Islands

**Island**:
A project tagged `layer:island`. It is written as if published to npm. It depends only on other islands, never on a host's runtime.
_Avoid_: Pure package, leaf library

**Host**:
An app that runs islands and owns the process: it reads the environment, writes to the console, and passes values in.
_Avoid_: Shell, runner

**Host runtime**:
A package that only a host may import, such as `electron` or `hono`. `islandConstraint()` bans these packages in islands.
_Avoid_: Framework dependency

**Library code**:
The code of every island, plus the files that `settings.island.libraries` names. Library code does not read `process.env` and does not write to the console.
_Avoid_: Shared code

**Port**:
An interface that an island declares and a host implements, such as a store or a requester. A port returns `unknown`, never a generic type.
_Avoid_: Adapter interface, contract

### Manifests

**Project shape**:
What a project's `package.json` must declare, decided by its build target as Nx resolves it: bundled or unbundled.
_Avoid_: Project kind, inline/external

**Bundled project**:
An application whose build inlines all the workspace packages it imports, such as a Vite app, or esbuild with `bundle` on and none of those packages in `external`. Its manifest declares every npm package those packages pull in, but not the workspace packages themselves.
_Avoid_: Inline project

**Unbundled project**:
Every project that is not bundled: libraries, an `nx:noop` shell, esbuild with `bundle: false`, esbuild that names a workspace package it imports in `external`. Its manifest declares what its own code imports, but not the workspace packages that its build inlines.
_Avoid_: Library (when shape is meant)
