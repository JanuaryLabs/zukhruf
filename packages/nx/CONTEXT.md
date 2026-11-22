# Nx

This package is the Nx part of the monorepo standard. Each area gives one part of the Nx configuration that the workspaces copied. The `format` area gives each project two targets: one that writes the files with Prettier, and one that only reads them. No workspace copies them. A check target never writes. The `test` area gives the test target to each project that owns test files. The `lint` area adds the lint packages to the inputs of the lint target. The `opentofu` area gives the OpenTofu targets to each project with environments. The `prisma` area gives the Prisma targets to each project with a `prisma.config.ts`. The generators `preset` and `init` write the root files of a workspace, the app generators write projects, and the `prisma`, `auth` and `dokploy` generators add a db package, better-auth and the infra project to a node-app. An Nx migration brings a later change of that output to a repo that ran a generator before.

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
The target `lint` that `@nx/eslint/plugin` gives. Its name is the `targetName` of the `@nx/eslint/plugin` entry, and `lint` when the entry has none. It runs `eslint .` in the project root, and Nx caches it. The `lint` area does not make it and does not change its command. It adds only inputs.
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

**Environment**:
A folder `src/environments/<name>` of a project root with at least one `*.tf` file directly in it. It is one OpenTofu root module, with its own state and its own saved plan. Each environment is a configuration of the OpenTofu targets that work on one environment. The default environment is `production`, else the first environment by name.
_Avoid_: Stage, workspace (an OpenTofu workspace is a different thing), stack

**OpenTofu module**:
A folder of `*.tf` files of this package that an environment of a host calls, such as `opentofu/dokploy-stack`. It has inputs, outputs and its own `tofu test` files, and configures no provider.
_Avoid_: Terraform module, area (an area is a part of the package's TypeScript)

**Module call**:
The `module "stack"` block in a host's `main.tf`, with a git `source` at `ref=main`. Its inputs are the host's needs, such as the keys of `env`. The dokploy generator writes it once, and the repo owns it.
_Avoid_: Module instance, module usage

**Saved plan**:
The file `tfplan` that `preview` writes in an environment, with `tofu plan -out tfplan`. `show` shows it. It is encrypted with the state passphrase.
_Avoid_: Plan file, plan output

**Freshness check**:
The Node script of the `opentofu` area that `show` runs first. It stops when the environment has no saved plan, or when a file of the project changed after the plan. A file of the project is one that Git tracks or does not ignore.
_Avoid_: Stale check, plan guard

**Passphrase guard**:
The start of each OpenTofu target that reads the encrypted state: it stops when `TF_ENCRYPTION_PASSPHRASE` is empty or not set, then gives the value as `TF_VAR_tf_encryption_passphrase`. The checks have no guard.
_Avoid_: Secret check, env check

**Generate target**:
The target `generate` that the `prisma` area gives. It runs `prisma generate` in the project root. Nx caches it on the `*.prisma` files, `prisma.config.ts` and the Prisma packages, and restores the `output` folders of the generator blocks. `typecheck`, `build`, `test`, `lint` and `dev` depend on it through the `targetDefaults` that `init` writes (ADR 0019).
_Avoid_: Codegen target, prisma target (text2sql has a different target with that name)

**Generator**:
An Nx generator of this package, in `generators.json`. It writes files through a `Tree`, and Nx writes the changes to disk after it ends. `preset` and `init` write the root files (#3337), the app generators write projects (#3338), and `prisma`, `auth` and `dokploy` add a db package, better-auth and the infra project to a node-app.
_Avoid_: Schematic, template, scaffold

**Nx migration**:
A function of this package in `migrations.json`, with the package version that brings it, for example `add-migrate-check` of 0.8.44. `nx migrate --run-migrations` runs it on a repo that ran a generator before: it adds only what is missing, and logs the step to take by hand where a file lost the shape that the generator wrote ([ADR 0017](./docs/adr/0017-nx-migrations-bring-a-change-of-generated-output-to-the-repos-that-ran-the-generator-before.md)). In the text about `migrations.json` and `nx migrate`, "migration" alone means an Nx migration.
_Avoid_: Codemod, upgrade script

**Preset**:
The generator `preset`. create-nx-workspace runs it just after `nx new`, in a new folder or in an empty Git repo (`.`). It replaces the files of `nx new` that the standard owns, and then runs `init`.
_Avoid_: Template (create-nx-workspace has a different template flow), starter

**Root file**:
A file at the workspace root that the monorepo standard owns, for example `nx.json`, `tsconfig.base.json`, `.npmrc` or a Git hook. `init` creates a missing root file, adds missing lines, and merges keys. It never deletes.
_Avoid_: Config file (a project has config files too), boilerplate

**Nx family**:
The root `nx` and each root `@nx/*` package. A generator gives them one exact version, `nxVersion` of the package, also over a newer version, so npm installs one `nx`.
_Avoid_: Nx plugins (a plugin is one kind of `@nx/*` package), Nx packages

**Workspace scope**:
The scope of the root package name: `acme` for `@acme/source`. One function reads it, and it stops with an error for a name with no scope.
_Avoid_: Org, namespace, prefix

**App generator**:
One of `node-app`, `react-app`, `pair` and `ui-package`. It runs `init`, calls the generator of Nx for its kind (`@nx/node`, `@nx/react`, `@nx/vitest`), and then writes the files and keys of the standard for that kind of project.
_Avoid_: Project generator, scaffold, template

**Pair**:
The generator `pair`, and what it makes: a web app that imports the generated client of a backend, and a backend that serves the build of the web app and puts it in its image. The two projects have no edge in the project graph other than the client.
_Avoid_: Link, connect, full-stack app

**Generated client**:
The package `@<scope>/<app>-client` in `<app>/.sdk-it`, which `sdk-it generate` writes from the Hono routes of a backend. Only its `package.json` and `tsconfig.json` are committed; its `sdk` target writes the rest, and `^sdk` runs it before a consumer typechecks, builds, tests, lints or runs `dev` (ADR 0019).
_Avoid_: SDK (the CLI is sdk-it), API client package

**Build sha**:
The commit that an image is built from: the `BUILD_SHA` build arg of the Dockerfile, an env variable in the image, and the `sha` of `/api/healthz`. It is `null` in a process that is not an image.
_Avoid_: Version, revision, git hash

**Residue**:
A root package that a generator of Nx adds and no project loads, for example `@swc/core` or `eslint-plugin-react`. An app generator deletes a residue package only when its own run added it.
_Avoid_: Junk, leftovers, extra dependency

**Infra project**:
The OpenTofu project `infra/` that the `dokploy` generator writes, named `@<scope>/infra`. Its environment `production` stores the compose in Dokploy. zukhruf's `tofu-apply.yml` calls it its `stack`.
_Avoid_: Terraform project, stack (except as the input of `tofu-apply.yml`)

**Release job**:
The job of the deploy workflow that rolls the stored compose out with `dokploy-deploy` and waits with `wait-for-health`. It runs after a new image, after an apply that changed the infra project, and while the infra project is affected since the last successful deploy.
_Avoid_: Deploy step, rollout script

**Public host**:
The name that Traefik routes to the app: a DNS name in a Hetzner zone, or `<name>.<ipv4>.sslip.io`. OpenTofu gives it to the compose as `PUBLIC_HOST` and outputs it as `host`.
_Avoid_: Domain (Dokploy has domain resources), URL

**Pull registry**:
The `dokploy_registry` that logs the Dokploy server in to GHCR, so a compose deploy pulls private images. `registryUser` adds it.
_Avoid_: Image registry (GHCR is the registry), docker login

**Db package**:
The package that the `prisma` generator writes, `@<scope>/<name>`: the Prisma schema, the migrations, `createPrisma` and the test helper. Its generated client in `src/prisma` is not committed; the `generate` target writes it. A backend bundles it.
_Avoid_: Prisma project, persistence layer, ORM package

**Prisma migration**:
A folder `migrations/<timestamp>_<name>` of a db package with one `migration.sql`, which changes the database schema one step. `prisma migrate deploy` applies it, schema replay runs it in tests, and `migrate:check` fails when the migrations do not build the schema ([ADR 0018](./docs/adr/0018-migrate-check-diffs-the-migrations-on-a-shadow-database-that-it-makes.md)). In the text about a db package and the `prisma` area, "migration" alone means a Prisma migration.
_Avoid_: Changeset, database patch

**Schema replay**:
What `applySchema` of `<db package>/testing` does: it runs each committed `migration.sql` in order on an empty test database, with no `_prisma_migrations` record. `prisma migrate deploy` applies migrations everywhere else.
_Avoid_: Migrate, seed, reset

**Shadow database**:
The empty Postgres database on which `prisma migrate diff --from-migrations` replays the migrations, to compare them with the schema. Prisma empties it on each use and never creates it. `migrate:check` and `migrate:create` take a new one from `@zukhruf/testing/postgres` for each run and drop it after (ADR 0018).
_Avoid_: Dev database (that one keeps its data), test database
