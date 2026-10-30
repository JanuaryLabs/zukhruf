# Nx

This package is the Nx part of the monorepo standard. Each area gives one part of the Nx configuration that the workspaces copied. The `format` area gives each project two targets: one that writes the files with Prettier, and one that only reads them. No workspace copies them. A check target never writes. The `test` area gives the test target to each project that owns test files. The `lint` area adds the lint packages to the inputs of the lint target.

## Language

**Area**:
One part of the package, with its own import path, for example `@zukhruf/nx/format`. The package has no root entry point. An area comes into the package when its own count is due under the Rule of Three.
_Avoid_: Module, feature, sub-package

**Format target**:
The target `format`. It runs `prettier --write` on the project root. It writes files. It runs only when a person or an agent runs it on purpose. No target depends on it.
_Avoid_: Fix target, lint target, prettier target

**Check target**:
The target `format:check`. It runs `prettier --check` on the project root. It only reads files, and it fails when a file is not formatted. Nx caches its result. `typecheck` depends on it.
_Avoid_: Verify target, lint (lint is a different target), format (format writes)

**Inferred target**:
A target that a `createNodes` plugin gives to a project. Nx applies inferred targets first, so `targetDefaults` and `project.json` can change them.
_Avoid_: Default target (a target default only fills a target that exists), generated target

**Opt-in**:
An entry that a project adds only to get a target from `targetDefaults`, for example `"format": {}`. A target default never makes a target, so each project had to add one. This package removes the need for opt-ins.
_Avoid_: Stub, placeholder

**Override**:
A target in the `project.json` of a project that replaces an inferred target, for example `tofu fmt -recursive` for an OpenTofu project.
_Avoid_: Customization, patch

**Project root**:
A folder that Nx makes a project: each folder with a `project.json`, and a folder with a `package.json` when the workspace globs match it or it has a `project.json` too. The workspace root is one only with a `project.json` or an `nx` key in its `package.json`. The plugin uses the matcher of Nx itself, and it gives the two targets to each project root that the plugin entry does not exclude.
_Avoid_: Package folder (a project root can have no package), workspace (the workspace is the whole repo)

**Fixture**:
A folder that a test uses as input. It can have a `package.json`, but it is not a project of the workspace. Outside the workspace globs, it gets no targets. Inside them, the `exclude` of the plugin entry in `nx.json` leaves it out.
_Avoid_: Sample, mock project

**Test file**:
A file whose name ends with `.test.ts`, `.test.mts`, `.test.cts`, `.test.js` or `.test.mjs`. It belongs to its nearest project root.
_Avoid_: Spec file, test suite

**Test target**:
The target `test` that the `test` area gives. It runs `node --test` in the project root. A project root gets it when it owns a test file, has no Vitest config, and is not the workspace root. It has no cache. The `timeout` and `flags` options of the plugin entry change it for each project. The `args` of one project change it for that project.
_Avoid_: Unit target, node test target, `test:node` (that is an old tag)

**Test selection**:
The files that the test target runs, in `options.args`. By default it is one glob for each top-level folder that has test files, for example `"src/**/*.test.ts"`, and a glob with no `**` for test files directly in the project root. `--args` replaces it. A Node flag on the CLI, for example `--test-name-pattern`, keeps it.
_Avoid_: Test pattern (Node's default pattern is a different thing), filter

**Docker test**:
A test that starts containers through `@zukhruf/testing`. Its project has the tag `test:docker`. Its test target also gets the global setup, `--test-force-exit` and `cache: false`.
_Avoid_: Integration test (not all integration tests use Docker), container test

**Global setup**:
The module that `node --test` runs one time before the test processes, and whose teardown runs after them. For a Docker test it is `@zukhruf/testing/docker-global-setup`, or the project's own `src/testing/docker-global-setup.ts`. Its value is a path, not a package name.
_Avoid_: Setup file, bootstrap, shim

**Lint target**:
The target `lint` that `@nx/eslint/plugin` gives. It runs `eslint .` in the project root, and Nx caches it. The `lint` area does not make it and does not change its command. It adds only inputs.
_Avoid_: Lint check, eslint target

**Lint inputs**:
The `inputs` of the lint target. `@nx/eslint/plugin` gives the files and the ESLint configs. The `lint` area adds the lint packages. A lint input that is missing gives a cached pass that is stale.
_Avoid_: Lint cache key, hash list

**Lint package**:
A package that ESLint loads when it lints, for example `typescript-eslint`. For an installed `@zukhruf/eslint`, the lint packages are all the packages that its lockfile edges reach. A lint package of one workspace goes in `targetDefaults.lint.inputs`, after `"..."`.
_Avoid_: Lint dependency, eslint plugin (that is one kind of lint package)

**Lockfile edge**:
A link from a package to a name in its `dependencies`, `peerDependencies` or `optionalDependencies`, as Nx reads it from the lockfile. An input on one package hashes all the packages that its edges reach.
_Avoid_: Transitive dependency (an edge can be a peer)
