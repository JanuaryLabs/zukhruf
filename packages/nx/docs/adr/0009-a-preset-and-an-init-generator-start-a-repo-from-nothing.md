# A preset and an init generator start a repo from nothing

Status: Accepted 2026-11-18 by the owner (backlog #3337).

factory writes the root files of the monorepo standard with the `workspace` generator of its private package `@factory/foundation` (`tools/foundation/src/generators/workspace`). Each root file has 3 to 7 copies in the repos: `.husky` hooks and the `prepare` script (7), the `.prettierrc` shape (6), `sync.applyChanges` (7), the Nx plugin list (7), `analytics: false` (6), `tui.enabled: false` (4), `.npmrc` `legacy-peer-deps=false` (4), `.vscode` (5), `.nvmrc` (3), `.gitattributes` (3) (#3337). meddit (`~/Desktop/mo/meddit`) is the third repo that starts from the standard, so condition 48 of #3259 is met. The owner decided on 2026-11-18 to extract the generators to zukhruf first, and then to generate meddit from npm (plan `snoopy-gathering-ripple.md`). meddit already has `.git` and a backlog registration, so it must not be deleted or created again.

The audit of 2026-11-18 found these gaps in factory's generator:

- It cannot start from nothing. `updateJson` throws when `package.json` or `nx.json` is missing. It is private, so it runs only from the factory checkout.
- It writes no `tsconfig.base.json`, no solution `tsconfig.json`, no TypeScript 7 alias, no `.nvmrc`, no `save-exact`, no `.gitattributes`, no `.editorconfig`, no `.vscode`, no `AGENTS.md`, no `analytics`, `tui` or `namedInputs`, and no ESLint `ignores`.
- It installs Tailwind, React and Vitest in each repo, also in a repo with only a backend.
- It leaves `nx` at the version of the template next to `@nx/*` at its own version, so npm nests 9 copies of `nx` (#4532).
- It reads the scope with the same regex in 2 places (#4080).

Nx 24.0.6 (the published source, read on 2026-11-18) gives these facts:

- `create-nx-workspace <name> --preset=<package>` installs `nx` and `@nx/workspace` at its own version in a temporary folder (`create-nx-workspace/dist/src/create-sandbox.js:18-29`), runs `nx new` (`create-empty-workspace.js:19-67`), and then runs `nx g <package>:preset` in the new folder with the options of its command line (`create-preset.js:8-38`). The generator must be named `preset`.
- `nx new` writes `package.json` (`@<name>/source`, a `packageManager` key, `nx` and `@nx/workspace`), `nx.json`, `.gitignore`, `.editorconfig`, `.vscode/extensions.json` and `README.md`, puts the preset package in `dependencies`, and installs (`@nx/workspace/dist/src/generators/new/new.js:12-35`, `generate-workspace-files.js:119-176`, `generate-preset.js:271-276`).
- `create-nx-workspace .` scaffolds into the current folder: the name is the folder name, `nx new` gets `skipEmptyDirCheck`, and in a Git work tree no `git init` and no commit runs (`create-nx-workspace/dist/bin/create-nx-workspace.js:612-660`, `create-empty-workspace.js:31-37`, `new.js:68-73`, `utils/git/git.js:141-149`).
- `nx g` with no `nx.json` stops with exit code 1 (`nx/dist/bin/nx.js:63`, `:108-110`, `:151-167`). `nx init` in a folder with no `package.json` makes a `.nx/installation` setup for a repo that is not JavaScript (`nx/dist/src/command-line/init/init-v2.js:137-141`).
- A generator returns a `GeneratorCallback`, and Nx runs it after it writes the files (`nx/dist/src/config/misc-interfaces.d.ts:11-15`). `@nx/devkit` gives `installPackagesTask` and `runTasksInSerial` (`@nx/devkit/dist/src/tasks/install-packages-task.js:15-42`, `generators/run-tasks-in-serial.js:9-15`).
- `tree.changePermissions` records a mode, and Nx applies it when it writes the file (`nx/dist/src/generators/tree.js:185-211`, `:279-292`). `formatFiles` writes each file again with no options, so it drops a mode set before it (`@nx/devkit/dist/src/generators/format-files.js:119`). The `Tree` has no links.
- `nx.json` `extends` is a shallow merge of the top-level keys (`nx/dist/src/config/nx-json.js:14-22`), so `release`, `sync`, `plugins`, `analytics` and `tui` can be shared only by a generator that writes them.

The owner approved the design on 2026-11-18 with these words: "the root generator named 'init' (not 'workspace'), so 'nx add @zukhruf/nx' runs it; nx family pinned to @zukhruf/nx's own nxVersion even if it downgrades; refuse a root package name with no @scope; Bundler-only tsconfig; drop factory's eslint-config splice" (#3337).

## Decision

The package gets two generators, in the `generators` field of its `package.json`. `preset` starts a repo through create-nx-workspace. `init` writes the root files of the standard §1–8 into an Nx workspace, and is safe to run again. Its name is `init`, so `nx add @zukhruf/nx` installs the package and runs it (`nx/dist/src/command-line/init/configure-plugins.js:61-87`, `add/add.js:118-129`). The README section `## generators` gives the files and the keys.

1. **The seam for a new repo is the preset of create-nx-workspace.** The generator is named `preset`, as `create-preset.js:34` needs. Its schema does not set `additionalProperties: false`, because create-nx-workspace passes each option of its command line to it (`create-preset.js:9-17`; `nx/dist/src/utils/params.js:175-185`).
2. **The seam for an existing empty Git repo is the same command with `.` as the name.** meddit runs `npx create-nx-workspace@latest . --preset=@zukhruf/nx --pm=npm --nxCloud=skip --aiAgents=none` in its own folder. No step deletes the folder or `.git`, and no commit runs. The package writes no code of its own for this case.
3. **`preset` owns the files of `nx new`; `init` keeps what it finds.** `preset` runs a moment after `nx new`, so it replaces `.gitignore`, `.editorconfig`, `.vscode/extensions.json` and `README.md`, deletes `packageManager`, the empty `dependencies` and `@nx/workspace`, and moves `@zukhruf/nx` to `devDependencies`. It also deletes `apps/.gitkeep` and `libs/.gitkeep`, which `nx g` writes into the `Tree` before it calls a generator named `preset` (`nx/dist/src/command-line/generate/generate.js:250-253`). Then it calls `init`. `init` creates a missing file, adds missing lines, and merges keys. It never deletes. `packageManager` must go, because `NoNumericPins` of `@zukhruf/git-hooks` refuses a version written as a number, so the first commit would fail.
4. **The Nx family has one exact version: `nxVersion` of the shared versions module.** `init` sets the root `nx` and each root `@nx/*` to it, also when another version is there and when that is a downgrade (#4532). A test checks that the root `nx` equals `nxVersion`. A missing `@zukhruf/*` package gets the version of `@zukhruf/nx` itself, and a version that is there stays, as for the other root tools. The generator reads that version from the `package.json` of `@zukhruf/nx`: nx release gives each public package the same version (`nx.json` `release.projects: ["tag:npm:public"]`, no groups).
5. **One function reads the workspace scope from the root package name** (#4080). It stops with an error for a name with no scope, and no generator writes a fallback scope. Its callers are the `importOrder` of `.prettierrc` (#3337), the client package name and the portless domain of `node-app` (#3338): 3 places.
6. **A root file holds no wiring of one kind of app.** `init` installs and configures only what the root files load: the Nx family for `@nx/js/typescript` and `@nx/eslint/plugin`, TypeScript 7 with the TypeScript 6 API alias, ESLint and the root configs of `@zukhruf/eslint`, Prettier with the sort-imports plugin, `@zukhruf/git-hooks` and `@zukhruf/nx`. A key that names a plugin which only one kind of app installs belongs to the app generator that installs that plugin: `generators["@nx/node"]`, the `@nx/esbuild:esbuild` default, `^sdk`, the Tailwind sync generator, `prettier-plugin-tailwindcss`, Vite and Vitest (#3338). The configs `hono`, `react`, `react-router` and `tailwind` go in the project's own `eslint.config.mjs`, as §6 says, not in the root config. A pattern that matches no file is not wiring, so the ignore lists, the `./env` and `./startup` entries of `importOrder`, and the `**/styles.css` glob of `Sync` stay in each repo.
7. **The hooks get their mode from the `Tree`, and their links from a callback.** The generator calls `tree.changePermissions(<hook>, '755')` after `formatFiles`. The callback writes only the missing links. Both generators return `runTasksInSerial(installPackagesTask, linkHooks)`. The install runs only when the generator changed `package.json`.
8. **The content of each written file is a string in a `.ts` module.** `tsc` builds only `.ts` files, so `dist` has the content with no copy step. `files` adds `generators.json` and the `schema.json` files.

What stays in factory: the brand (the `@factory` fallback, fonts, colors, favicons), the mirror tests that compare factory's own root files with the generator output (they call `@zukhruf/nx:init` after #4611), and `--test-force-exit` for each project in the options of `@zukhruf/nx/test`.

## Considered Options

- **`nx init` in the empty repo, then `nx g @zukhruf/nx:init`.** REJECTED. In a folder with no `package.json`, `nx init` sets up Nx for a repo that is not JavaScript (`init-v2.js:137-141`). The result is not an npm workspace.
- **`nx g @zukhruf/nx:init` in a folder with no `nx.json`.** REJECTED. Nx stops before it loads a generator (`nx/dist/bin/nx.js:108-110`).
- **Create meddit in another folder, and move `.git` into it.** REJECTED. The owner requires that the folder is never deleted or created again. `create-nx-workspace .` makes the move unnecessary.
- **Write the root files with a script of our own, outside Nx.** REJECTED. create-nx-workspace already runs a preset, installs, formats and initializes Git. A script would copy those steps.
- **The template flow of create-nx-workspace (`--template`).** REJECTED. It accepts only repositories of the `nrwl` GitHub organization (`create-workspace.js:46-49`). A probe on 2026-11-18 with `create-nx-workspace@24.0.6` got `nx` 24.0.0 from the template, which is the cause of #4532.
- **One generator for both: `preset` keeps what it finds, as `init` does.** REJECTED. When `preset` runs, `nx new` has already written `.gitignore`, `.editorconfig`, `.vscode/extensions.json`, `README.md` and a `packageManager` key. "Create when missing" would keep the files of Nx, not the files of the standard.
- **The name `workspace` for the generator that adds the root files.** REJECTED by the owner. `nx add @zukhruf/nx` runs only a generator named `init`.
- **Take the Nx version from the root `nx` that create-nx-workspace installed.** REJECTED by the owner. It never downgrades, but a `create-nx-workspace@latest` of a new major gives a version that the peer range of `@zukhruf/nx` (`<25`) does not allow.
- **`addDependenciesToPackageJson` of `@nx/devkit` for the Nx family.** REJECTED for the Nx family. It never writes a lower version (`@nx/devkit/dist/src/utils/package-json.js:193-228`), so it cannot bring `nx` down to `nxVersion`. It fits the other root tools with `keepExistingVersions`.
- **The root ESLint config loads the `hono`, `react`, `react-router` and `tailwind` configs, as factory does.** REJECTED. A repo with only a backend then needs the React and Tailwind plugins installed. §6 puts them in the project config.
- **Port factory's splice of an existing `eslint.config.mjs`.** REJECTED by the owner. No consumer needs it: meddit gets a new file, and factory and whatisgoingon have their config. Its test (a multi-line import) is dropped with it.
- **An option for the tsconfig kind (Bundler or NodeNext).** REJECTED by the owner. Each consumer (factory, whatisgoingon, meddit) bundles its apps. zukhruf and elt run from source, but they do not use the generator. This is strike 1 for NodeNext.
- **Templates as files in `files/`, read from `import.meta.dirname`, as factory does.** REJECTED. The package ships `dist`, and `tsc` does not copy them.
- **Write no scope entry in `importOrder` for a root package name with no scope, as factory does.** REJECTED by the owner. A generator stops with an error.
- **A shared helper for the scope only after its third caller ships.** Not selected. The 3 callers are known and scheduled (#3337, #3338), and #3337 lands first.

## Consequences

- meddit starts with one command, from npm. Each other repo gets the root files with `nx g @zukhruf/nx:init` (C1 factory #4611).
- A repo with only a backend installs no React, Vite, Vitest or Tailwind package.
- One `nx` is installed. An update of `nxVersion` is a release of `@zukhruf/nx`.
- The generators write `nx.json` keys that `extends` cannot share, so a repo that ran `init` gets a later change of the standard only when it runs `init` again. A "create" file never changes: a later change of a hook or of `tsconfig.base.json` is a manual edit in each repo, as with factory today.
- In a new folder, `git init` comes after the install, so `prepare` sets `core.hooksPath` only on the next `npm install`.
- zukhruf uses Nx 23.2.1 itself. The tests of the generators run on `@nx/devkit` 23.2.1, inside the peer range, and the smoke test runs the preset under create-nx-workspace 24.
- create-nx-workspace takes the version of a third-party preset from `NX_E2E_PRESET_VERSION` when it is set (`@nx/workspace/dist/src/generators/new/new.js:114-118`). So a smoke test runs the preset from an `npm pack` tarball before the release: `NX_E2E_PRESET_VERSION=file:<tarball>`.
- `CONTEXT.md` needs the words of this area: generator, preset, root file, Nx family, workspace scope.
