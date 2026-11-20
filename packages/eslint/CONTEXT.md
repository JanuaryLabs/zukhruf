# ESLint

The shared lint rules of several repos, packaged once. A repo picks configs by name and gives its own values as options or as repo settings. The package never takes a rule key that a repo fills with its own entries.

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

**Modern Node**:
The namespace `modern-node` and the config `modern-node/recommended`. Its checks report code that a newer Node or JavaScript API can replace. A new check of this kind joins the namespace, and it does not get a name under `zukhruf/`.
_Avoid_: Modernization preset, node-native rule

**shadcn**:
The config `zukhruf/shadcn`. Its checks are on the use of `@zukhruf/shadcn`, the component kit. `@zukhruf/eslint/react` is another thing: the configs of the React community, with no check of the package.
_Avoid_: React config, `zukhruf/react` (its old name)

**shadcn-strict**:
The export `@zukhruf/eslint/shadcn-strict`. A host of the kit spreads it after **shadcn** once it has fixed its hits: `zukhruf/no-data-slot-restyle` and the rules of `@shadcn/lint`, at `error`.
_Avoid_: Strict mode, shadcn lint config

**Repo-owned rule**:
A rule whose options are one list that each repo fills with its own entries: `no-restricted-syntax`, `no-restricted-imports`, `@typescript-eslint/no-restricted-imports`. The package never sets these rules.
_Avoid_: Shared rule

**Repo setting**:
A fact about the repo that a rule reads from `settings`, such as `settings.island.libraries` or `settings.env.startupFile`. A repo gives it once, and does not set the rule again, so the config keeps its `files` and `ignores`.
_Avoid_: Global option

**Startup file**:
The file of a project that validates the environment once, at boot, with `const env = z.object({...})`. The default is `src/startup.ts`. `settings.env.startupFile` names a different file.
_Avoid_: Env file

**Option factory**:
A function that returns a rule's complete options, with a repo's entries added to the shared ones. Examples are `noLet()`, `reactRouterOnlyThrowError()`, `dependencyPolicy()` and `moduleBoundaries()`.
_Avoid_: Options helper, builder

**Typed lint**:
The block `zukhruf/base/typed` of `base`, which sets `parserOptions.projectService`. It gives each TypeScript file the types of its nearest `tsconfig.json`. `zukhruf/no-promise-field`, `zukhruf/no-phase-flag`, the `recommended-type-checked` rules of `@zukhruf/eslint/react` and `unicorn/prefer-dispose` of `modern-node/recommended` need it, so a repo uses those configs together with `base`. Each linted TypeScript file must be in a tsconfig.
_Avoid_: Type-aware mode, type checking

**Phase flag**:
A class field that is a boolean, or that can be `undefined` or `null`, when code outside the constructor sets it. A `let` of the same types is one too, when a function that its function returns sets it. Its value records a phase, so every reader must know which phase holds. `zukhruf/no-phase-flag` reports it (commit 07bbd39e, #2489). A lazy memo is not a phase flag.
_Avoid_: Status flag, mode field

**Lazy memo**:
A field or `let` whose every write is `x ??= …`, so its value never becomes empty again. `zukhruf/no-phase-flag` does not report a lazy memo whose every read is the value of a `??=` or comes after a top-level `x ??= …;` of the same function body; one that nothing reads is a flag (#3510, commit 03d15bd5). `zukhruf/no-captured-assignment` does not report a `??=` write. `||=` and `&&=` are not a lazy memo, because they can set the value again.
_Avoid_: Cache, lazy init

### Where a rule applies

**Workspace root**:
The nearest folder at or above the linted file that has `nx.json`, `pnpm-workspace.yaml`, or a `package.json` that declares `workspaces`.
_Avoid_: Repo root, cwd

**Workspace package**:
A package whose folder the `workspaces` globs of the root `package.json` match. A project imports it by the `name` in its own `package.json`. A bundled project inlines the workspace packages that it imports, and its manifest does not declare them.
_Avoid_: Local package, internal package

**Roots**:
A rule option: folders relative to the workspace root where the rule applies. An empty list means everywhere.
_Avoid_: Paths, scope globs

**Project**:
The nearest folder at or above the linted file that has a `project.json` or a `package.json`, with the tags those files declare.
_Avoid_: Package (when tags matter)

**Project configuration**:
The Nx settings of a project: its `project.json`, and the `nx` key of its `package.json`. Nx merges the two.
_Avoid_: Project file, Nx config

**TS solution workspace**:
A workspace root with package-manager workspaces, a `tsconfig.json` that extends `./tsconfig.base.json` and includes no file, and a `composite` `tsconfig.base.json`, as `isUsingTsSolutionSetup()` of `@nx/js` decides.
_Avoid_: Project references setup

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
Every project that is not bundled: libraries, an app that compiles with tsc, an `nx:noop` shell, esbuild with `bundle: false`, esbuild that names a workspace package it imports in `external`. Its manifest declares what its own code imports, but not the workspace packages that its build inlines.
_Avoid_: Library (when shape is meant)

**Test file**:
A file whose name ends in `.test.` or `.spec.` followed by a test extension, such as `lock.test.ts`. `isTestFile()` matches only this name. The configs also count each file in `src/testing` as a test file, because the build does not ship it: `tests` lints it, and a config that skips test files skips it too (commit 9dc4f0a0). Test support is a different term: it is about the imports of a manifest, in any `testing/` folder that the manifest does not publish.
_Avoid_: Spec file, test module

**Test support**:
The code in a `testing/` folder that the project's manifest does not publish through `exports` or `files`. Tests import it, and the project does not ship it. Its imports are not dependencies.
_Avoid_: Test helpers (when the folder is meant)
