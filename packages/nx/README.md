# @zukhruf/nx

This package is the Nx part of the monorepo standard. Each workspace copied the same Nx configuration into each project. This package gives that configuration one time, in areas. Each area has its own import path, and the package has no root entry point. Two [generators](#generators) write the root files of a workspace, four [app generators](#app-generators) add its projects, the [prisma generator](#prisma-generator) adds a db package, the [auth generator](#auth-generator) adds sign-in to a backend, and the [dokploy generator](#dokploy-generator) adds the delivery of a backend. The [release configuration](#release) gives the release policy that `nx.json` extends. The lint rules stay in `@zukhruf/eslint`, and the Git hooks stay in `@zukhruf/git-hooks`. [Monorepo standard](#monorepo-standard) says where each rule of the standard lives, and why.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Areas

| Area             | Import path                | Status                                                                                                                                               |
| ---------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| format           | `@zukhruf/nx/format`       | This README                                                                                                                                          |
| test             | `@zukhruf/nx/test`         | This README                                                                                                                                          |
| lint             | `@zukhruf/nx/lint`         | This README                                                                                                                                          |
| portless         | `@zukhruf/nx/portless`     | Candidate (#3336): 14 projects in 3 repos                                                                                                            |
| opentofu, prisma | `@zukhruf/nx/<area>`       | This README (#3339)                                                                                                                                  |
| generators       | `@zukhruf/nx:<name>`       | This README: `preset` and `init` (#3337); `node-app`, `react-app`, `pair`, `ui-package` (#3338); `dokploy` (#4603); `prisma` (#4604); `auth` (#4719) |
| migrations       | `nx migrate`               | This README (#4818)                                                                                                                                  |
| release          | `@zukhruf/nx/release.json` | This README (#4677)                                                                                                                                  |

The lint rules stay in `@zukhruf/eslint`. The `lint` area gives only the inputs of the `lint` target (#3335).

## monorepo standard

The monorepo standard is the set of rules that each new Nx repo follows. The generators of this package write it. The Nx plugins of this package, the rules of `@zukhruf/eslint` and the steps of `@zukhruf/git-hooks` check it. It started as `docs/monorepo-standard.md` in whatisgoingon, which moved here in #4605. This section keeps only what no generator writes and no check runs: where each rule lives, the decisions with their reasons, the rules that are still prose, and the pitfalls. To read a rule that a generator writes, read the generator's section or its source.

### Where each rule lives

| Part of the standard                                                                                                                                       | Written by                                                                                                                                                                                                          | Checked by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tooling: npm workspaces, one exact version of the Nx family, TypeScript 7 with the TypeScript 6 API, exact root versions, `allowScripts`, peer `overrides` | `init` ([`root-package-json.ts`](./src/generators/init/root-package-json.ts), [`versions.ts`](./src/generators/versions.ts)); `preset` refuses another package manager; `node-app` adds the sdk-it peer `overrides` | `manifest/nx-family-pinned` ([`@zukhruf/eslint`](../eslint/README.md#every-other-manifest)); [`NpmrcPolicy`](../git-hooks/README.md#decide-how-npm-installs-in-the-repo) (`legacy-peer-deps=false`, `strict-allow-scripts=true`); [`LockfileSync`](../git-hooks/README.md#keep-package-lockjson-in-step-with-each-packagejson); [`OneRuntimeCopy`](../git-hooks/README.md#keep-one-copy-of-each-runtime-package) (one `react`, `react-dom` and `zod`); [`InstallScriptsReviewed`](../git-hooks/README.md#decide-each-install-script) (`allowScripts` decides each install script, for every platform); `manifest/no-root-script` (only `prepare`); `manifest/no-globstar-workspace` (single-`*` workspace globs, no `**`) |
| Versions as LTS aliases: `.nvmrc` `lts/*`, `node:lts-*` images, `npm@latest`, no `engines` and no `packageManager`                                         | `init` ([`files.ts`](./src/generators/init/files.ts)); the Dockerfiles of `node-app` and `prisma`; the workflows of `dokploy`                                                                                       | [`NoNumericPins`](../git-hooks/README.md#refuse-a-node-or-npm-version-written-as-a-number)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Root files and the layout `apps/`, `packages/`, `tools/`                                                                                                   | `init` and `preset`: [What the generators write](#what-the-generators-write)                                                                                                                                        | the `Format` step for the root files; `NpmrcPolicy` for `.npmrc`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| TypeScript: the Bundler base, and project tsconfigs that write to `out-tsc` with `rootDir: "src"`                                                          | `init` (base and solution file); the app generators and `prisma` (project tsconfigs)                                                                                                                                | `zukhruf/no-enum`; [`zukhruf/no-cross-project-paths`](../eslint/README.md#configs) (no `paths` alias between projects)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Nx: `nx.json` keys, plugins, target defaults, generator defaults; targets in the `nx` key of the project's `package.json`                                  | `init` ([`nx-json.ts`](./src/generators/init/nx-json.ts)); each app generator adds its wiring: [What only an app generator writes](#what-only-an-app-generator-writes)                                              | the `format`, `test` and `lint` areas, which no default may replace ([ADR 0001](./docs/adr/0001-inferred-targets-not-copied-defaults.md)); [`zukhruf/nx-project-json`](../eslint/README.md#configs): `no-missing-command-executor` (a shell target has an executor), `no-depends-on-project` (build order from the import graph), `no-duplicate-nx-key` (a key in `project.json` or in the `nx` key, not both)                                                                                                                                                                                                                                                                                                            |
| Format: `.prettierrc` and `.prettierignore`                                                                                                                | `init`; `react-app` adds `prettier-plugin-tailwindcss`                                                                                                                                                              | `format:check`; the `Format` step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Lint: the root and the project `eslint.config.mjs`                                                                                                         | `init` (root); each app generator and `prisma` (project)                                                                                                                                                            | the `lint` area; the configs of `@zukhruf/eslint`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Git hooks: `Sync`, `Format`, the manifest and lockfile steps, `Build` on pre-push, `NxReleaseScope` on commit-msg                                          | `init`                                                                                                                                                                                                              | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Tests: `node:test` everywhere, Vitest in a Vite app, no lifecycle hooks, `test:docker` for Docker tests                                                    | the `test` area; `react-app` (the Vitest block and its `test` target); `prisma` (the Docker test and the tag)                                                                                                       | `zukhruf/no-other-test-runner`, `zukhruf/no-test-lifecycle-hooks`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Backend: Hono, terminus, evlog, zod env, sdk-it client, one ESM bundle, Dockerfile, build sha                                                              | `node-app`                                                                                                                                                                                                          | the `hono` and `env` configs; [`DockerfileInstallsFromLockfile`](../git-hooks/README.md#install-from-the-lockfile-in-a-dockerfile)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Web: React Router in data mode, Vite, Tailwind, React Compiler, Vitest; a UI library                                                                       | `react-app`; `ui-package`                                                                                                                                                                                           | `@zukhruf/eslint/react`, the `react-router` and `tailwind` configs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Mobile: Expo                                                                                                                                               | no generator: [Mobile with Expo](#mobile-with-expo)                                                                                                                                                                 | [`@zukhruf/eslint/react-native`](../eslint/README.md#react-native-hermes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Pair of a web app and a backend                                                                                                                            | `pair`                                                                                                                                                                                                              | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Database: a Prisma 7 package on Postgres                                                                                                                   | `prisma`                                                                                                                                                                                                            | the `prisma` area                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Agent workflow: the commands in `AGENTS.md`                                                                                                                | `init` (`AGENTS.md`, `CLAUDE.md`)                                                                                                                                                                                   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Delivery: CI, deploy, encrypted OpenTofu state applied only by CI                                                                                          | `dokploy`                                                                                                                                                                                                           | the `opentofu` area (`typecheck` with no secret, no `apply` target, [ADR 0007](./docs/adr/0007-opentofu-targets-from-environments-with-no-apply.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Decisions and their reasons

| Topic                 | The sources disagreed                                                                                       | The standard                                                               | Why                                                                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web tests             | factory used Vitest and happy-dom; the zukhruf libraries used `node:test` only                              | Vitest in a Vite app, `node:test` everywhere else                          | The owner's decision of 2026-10-29. Vitest runs the app's own Vite config and transforms.                                                                                                                                                      |
| Vitest globals        | factory set `globals: true`                                                                                 | `globals: false`, and RTL's `cleanup()` in the `finally` of each test      | With `globals: true`, RTL registers an `afterEach`, which is a lifecycle hook.                                                                                                                                                                 |
| Root scripts          | factory had `build`, `check` and `lint` npm scripts; zukhruf, elt and context-compiler had only `prepare`   | only `prepare`                                                             | Each command runs through an Nx target.                                                                                                                                                                                                        |
| TypeScript            | factory used `typescript@6.0.3`; elt and context-compiler used TypeScript 7 with the TypeScript 6 API alias | TypeScript 7, with the TypeScript 6 API for typescript-eslint and `@nx/js` | The newest setup (elt, 2026-10-10), and it follows the Nx guide `nx.dev/docs/kb/typescript-7`. typescript-eslint peers on TypeScript `<6.1`.                                                                                                   |
| tsconfig base         | factory used Bundler resolution; zukhruf and elt use NodeNext                                               | Bundler for a workspace that bundles its apps                              | Different kinds of workspace. A workspace that Node runs from source uses `NodeNext` with `rewriteRelativeImportExtensions`; no generator writes it ([ADR 0009](./docs/adr/0009-a-preset-and-an-init-generator-start-a-repo-from-nothing.md)). |
| Expo                  | ipay used `@nx/expo` on Nx 21; bid and virtual-care wrote `run-commands`                                    | `@nx/expo/plugin`                                                          | The official plugin, with inferred targets (2026-10-29).                                                                                                                                                                                       |
| Infrastructure        | OpenTofu or Pulumi                                                                                          | OpenTofu with the state encrypted and committed, as text2sql v2 does       | The pattern of text2sql v2. CI is the only writer of the state, and it commits the state back with `[skip ci]`.                                                                                                                                |
| Deploy trigger        | text2sql deployed with a Dokploy webhook                                                                    | the release job calls the Dokploy API with the panel key                   | The fewest long-lived credentials (2026-10-29): the apply needs the panel key in CI anyway, so the webhook URL and the PAT that wrote it into the Actions secrets go.                                                                          |
| Delivery from day one | —                                                                                                           | a new repo ships from `main` before its first feature                      | The owner's rule of 2026-10-29. Nobody runs a deploy, an apply or a build by hand. The owner runs each command that writes a secret.                                                                                                           |

### Rules that are still prose

No generator writes these and no check runs them. Each one cost time once.

- Pass Nx flags through `npx nx`, never `npm exec`: npm eats the flags.
- Read each install script before you name it in `allowScripts`, and name a package with no version. [`InstallScriptsReviewed`](../git-hooks/README.md#decide-each-install-script) stops a script with no decision, on every platform, but not a wrong decision. The reasons so far: `esbuild: true`, because its postinstall links the native binary over the Node wrapper and downloads it when the platform package is missing; `nx: false`, because its postinstall only updates the Nx Cloud client and exits 0 on each error, and no repo uses Nx Cloud; `unrs-resolver`, `@parcel/watcher` and `fsevents` are native fallbacks.
- Add a package only for a real second caller.
- Fix each lint finding; no `warn` for later. A ban that names one repo goes in that repo's config, and a rule for each repo goes in `@zukhruf/eslint`. An ESLint config does not read the project graph when it loads ([ADR 0009 of `@zukhruf/eslint`](../eslint/docs/adr/0009-project-config-rules-read-the-file-not-the-graph.md) says why no rule checks it).
- No lint-staged: it put the files of other sessions into commits. Never `--no-verify` without asking.
- Test fixtures (a Docker database, an HTTP server, a temp folder, msw) come from `@zukhruf/testing`, and `await using` cleans them up.
- A React component of a library package is tested with `node:test`: the test registers a DOM with `@happy-dom/global-registrator`, then imports `react`, `react-dom/client` and the component from the built package. Node cannot load `.tsx`.
- `serve` of a backend runs the source with no `UI_ROOT`, so it has no UI route. In development the web app runs on the Vite dev server.
- NODE_ENV is `production` in every setup, and the generated code never reads it; each behavior that differs between setups has its own setting (`HOST`, `ALLOWED_ORIGINS`, `LOG_DIR`, `LOG_PRETTY`, `UI_ROOT`). The web `dev` and `serve` targets set `development` and its `test` target `test`, and so does the `test` of a ui-package ([ADR 0016](./docs/adr/0016-the-generated-code-reads-explicit-settings-and-never-nodeenv.md)).
- CI installs each tool that a target runs, for example OpenTofu for the `typecheck` of the infra project. It passed locally only because Homebrew had `tofu`.
- On a paid GitHub plan, move the deploy secrets into a `production` environment that only `main` can use.
- The owner does each one-time step: `gh auth refresh -s workflow` (a push of a workflow file needs the scope) and the repository secrets.

### Mobile with Expo

No generator writes a mobile app yet. This is the Nx 24 shape of 2026-10-29:

- `nx g @nx/expo:app apps/<name>`, with `@nx/expo/plugin`. Set `buildTargetName: "eas-build"`: a target named `build` would run `eas build` in the cloud from `nx run-many -t build` and from the pre-push `Build` step.
- The latest Expo SDK and `expo-router` (`main: "expo-router/entry"`, routes in `src/app/`). Install Expo modules with the inferred `install` target, so the versions match the SDK.
- After the generator: move its root `dependencies` (Expo, React, React Native) into the app manifest with real versions (it writes `"*"`), delete `jest-expo` and `@testing-library/react-native`, and delete `tools/scripts/eas-build-{pre,post}-install.mjs`. The one EAS hook of the app is `eas-build-post-install`, which runs the `sdk` target of the generated client, because EAS installs from Git.
- Root `overrides` pin `react` and `react-dom` to the version of the Expo SDK, and each app declares it. Two copies fail with "Invalid hook call".
- `app.json`: set `slug` and `scheme` by hand (the scoped project name is not valid there), `owner`, `android.package`, `ios.bundleIdentifier`, and `ios.infoPlist.ITSAppUsesNonExemptEncryption: false`, or each build waits for an export-compliance answer. Then `eas init --non-interactive --force` from the app folder.
- `eas.json`: `cli.appVersionSource: "remote"`, and a `base` profile that each profile extends, with `node` as an exact version (EAS accepts no alias; `NoNumericPins` leaves `eas.json` out). The app's `eas-build-pre-install` runs `npm install -g npm@latest`. EAS uploads what Git tracks, so each profile sets its `EXPO_PUBLIC_*` values in `env`.
- `metro.config.js` wraps the config in `withNxMetro`. Keep the name: `@nx/expo/plugin` finds an Expo project only by that file. It is CommonJS, so turn off `@typescript-eslint/no-require-imports` for it.
- `tsconfig.app.json` extends `["../../tsconfig.base.json", "expo/tsconfig.base"]` with `noEmit: false`, `outDir: "out-tsc"`, `rootDir: "src"` and `types: ["expo/types"]`.
- `src/env.ts` reads each `process.env.EXPO_PUBLIC_<NAME>` by name: Expo inlines only those static reads, so the backend's `safeParse(process.env)` does not work.
- `ios/` and `android/` come from `prebuild` and are ignored by Git. `app.json` is the source of truth.
- The app calls the backend through the generated client with `baseUrl` from `EXPO_PUBLIC_API_URL`. The client builds URLs with `new URL(path, 'local://')`, which only the `URL` of the Expo runtime accepts, so the client does not work in bare React Native. `start`, `serve`, `run-ios`, `run-android` and `export` depend on `^sdk`.
- Verify with what CI runs (`expo export`, `eas build --local --non-interactive`). `grep -a` on the `.hbc` files shows whether a string made it into the bundle.
- TestFlight from CI: `eas build --auto-submit --non-interactive` needs `submit.production.ios.ascAppId`. The owner creates the App Store Connect app once in the web UI and runs `eas credentials -p ios` once (build credentials, then an App Store Connect API key; the App Manager role is enough). EAS then creates the internal TestFlight group. "Couldn't switch to provider" can be a stale Apple session: run it again.

### Pitfalls

- After you move a project: `nx reset`, then `nx sync`, then diff the tsconfigs. A stale graph makes `sync` delete valid references.
- A phantom TS2307 or TS6305 comes from a stale `.tsbuildinfo`. Run `nx reset`; do not edit the references.
- An incremental `typecheck` can miss a `.tsx` call-site error after a move, and `tsc` does not see a bundler break. Verify with the real build.
- After you delete a workspace, delete its `extraneous` entries from `package-lock.json`. A commit that adds a package carries its lockfile entries and its root tsconfig reference.
- `@nx/esbuild`: `thirdParty` decides what is bundled; `additionalEntryPoints` duplicate shared classes and break `instanceof`; an asset that the root `.gitignore` matches is dropped; a failed watch rebuild deletes the output. `generatePackageJson` throws in a TS solution workspace: use `prune-lockfile` (`zukhruf/no-generate-package-json` of [`@zukhruf/eslint`](../eslint/README.md) reports it).
- `nx migrate --create-commits` runs `git add -A`. Read `migrations.json` first. `parallel` in `nx.json` takes only a number.
- A generator of Nx rewrites root files through an AST: it can drop the comments of `eslint.config.mjs` and add `@swc/helpers` again. Stage before a generator of Nx, and diff after.
- Nx applies a sync only in an interactive run. A piped or CI run stops with "The workspace is out of sync": run `npx nx sync`.
- When Nx detects an AI agent, it holds the output of a task until the task ends. Add `--output-style=stream-without-prefixes` to read a server while it runs.
- With no green CI run yet, `nrwl/nx-set-shas` falls back to `HEAD~1`, and `affected` sees only the last commit. zukhruf's `affected-range` action then takes the empty tree as the base, so every project is affected.
- On a Mac, Microsoft Defender has killed the `commit-msg` and `pre-push` hooks. A `pre-push` that dies with SIGKILL is that, not the build.
- The macOS firewall in stealth mode drops LAN connections to `node`, even from the same Mac, so Expo's LAN URL times out in Expo Go. On the simulator, start with `-- --ios --localhost`.
- The Claude Code TypeScript LSP finds no `tsserver.js` under the TypeScript 6 alias, so it shows no diagnostics. Use `nx run <project>:typecheck`.
- zsh does not split an unquoted variable into words: `kill $pids` with `pids="1 2 3"` passes one argument.

## format

An Nx workspace formats its files with Prettier. The `format` area is an Nx inference plugin. It gives each project of the workspace two targets: `format`, which writes the files, and `format:check`, which only reads them. You list the plugin one time in `nx.json`. You do not copy targets into each project.

### Use it

You need Nx 23 or 24 and Prettier 3. `nx`, `@nx/devkit` and `prettier` are peer dependencies.

Add the plugin to `plugins` in `nx.json`. Then add `format:check` to the `dependsOn` of `typecheck` that the workspace already has:

```jsonc
{
  "plugins": ["@zukhruf/nx/format"],
  "targetDefaults": {
    "typecheck": {
      "dependsOn": ["lint", "format:check", "..."],
    },
  },
}
```

Keep the entries that are already in the list. A `dependsOn` array replaces the array of an earlier source, and only `"..."` keeps the dependencies that `@nx/js/typescript` gives `typecheck`.

zukhruf builds this package, so it lists the plugin by path: `"plugins": ["./packages/nx/src/format/plugin.ts"]`. The package name resolves to `dist/`, and a fresh clone has no build before Nx makes the project graph.

The plugin does not change `typecheck`. That target belongs to `@nx/js/typescript`, and each workspace adds its own dependencies to it, for example `^sdk`. See [ADR 0001](./docs/adr/0001-inferred-targets-not-copied-defaults.md).

### Signature

```ts
// @zukhruf/nx/format
export const createNodes: CreateNodes;
```

The plugin takes no options. The target names and the commands are the same in each of the 7 copies that this package replaces, so no option is necessary.

### What each target runs

| Target         | Command                          | Writes? | Cached | Inputs                                                                                                                                                                                                                    |
| -------------- | -------------------------------- | ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`       | `prettier --write {projectRoot}` | yes     | no     | —                                                                                                                                                                                                                         |
| `format:check` | `prettier --check {projectRoot}` | no      | yes    | the files of the project; the root `.prettierignore` and `.editorconfig`; the config file that Prettier finds from the workspace root; `prettier` and each Prettier plugin that the config names (`externalDependencies`) |

- `format` writes. It runs only when you run it on purpose: `nx run <project>:format`. No target depends on it.
- `format:check` only reads. It fails when a file is not formatted.
- A project with no file that Prettier can format passes `format:check`. Prettier 3.9.9 passes a folder whose files are all ignored or of an unknown type. It stops with an error only for a folder with no file, and a project root always has a `project.json` or a `package.json`. Thus the command has no `--no-error-on-unmatched-pattern`.
- The plugin finds the config file with `resolveConfigFile` of Prettier, as the Prettier CLI does. It can be `.prettierrc`, `prettier.config.mjs` or the `prettier` key of the root `package.json`. That file is an input, so a change to it runs the check again. The Prettier CLI also reads `.editorconfig`, so that file is an input too. When Prettier finds no config file, no config file is an input.

To format only your own files, give their paths: `npx prettier --write <files>`. See [ADR 0002](./docs/adr/0002-a-check-never-writes.md).

### Override a project

A target in the `project.json` of a project replaces the inferred target. Nx applies the plugin first, then `targetDefaults`, then `project.json`. For example, the `infra` project of whatisgoingon formats OpenTofu files:

```json
{
  "targets": {
    "format": { "command": "tofu fmt -recursive" },
    "format:check": { "command": "tofu fmt -check -recursive" }
  }
}
```

### Leave fixtures out

The plugin gives targets only to the projects that Nx finds, by the rule and the matcher of Nx itself:

- Each folder with a `project.json` is a project.
- A folder with a `package.json` is a project only when the workspace globs of the package manager match its path, or when it has a `project.json` too. The globs are `workspaces` in the root `package.json`, `pnpm-workspace.yaml` and `lerna.json`, with their `!` negations.
- The workspace root is a project only when it has a `project.json`, or its `package.json` has an `nx` key. Even then it gets no format targets: its check would be `prettier --check .`, which checks each project again.

Thus a fixture outside the workspace globs gets no targets, and you do not add it to `exclude`. The root files stay checked by the `Format` step of `@zukhruf/git-hooks` and by `npx prettier --check .` in CI.

A fixture inside the workspace globs is a project of Nx. Use the standard `exclude` of an Nx plugin entry to give it no format targets:

```json
{
  "plugins": [
    {
      "plugin": "@zukhruf/nx/format",
      "exclude": ["packages/connectors/manifest/src/fixtures/**"]
    }
  ]
}
```

context-compiler already does this for `@nx/eslint/plugin`. See [ADR 0003](./docs/adr/0003-which-roots-get-targets.md).

### Migrate a workspace

1. Add the plugin to `plugins` in `nx.json`.
2. Delete the `format` and `format:check` entries from `targetDefaults`.
3. Delete each opt-in: each `"format": {}` and each copied `format` or `format:check` target in a `project.json` or in `nx.targets` of a `package.json`. Keep a target only when it is an override.
4. Delete `"format"` from `lint.dependsOn` and from `typecheck.dependsOn`.
5. Add `"format:check"` to `typecheck.dependsOn`.

| Workspace        | Today                                                                                        | Opt-ins to delete                  |
| ---------------- | -------------------------------------------------------------------------------------------- | ---------------------------------- |
| zukhruf          | targetDefault `format` = `--write`; `lint` depends on `format`                               | 32 `"format": {}`                  |
| elt              | same as zukhruf                                                                              | 69                                 |
| context-compiler | same as zukhruf                                                                              | 27                                 |
| text2sql         | a full `format` target in each project; `typecheck` depends on `format`                      | 75                                 |
| factory          | targetDefaults `format` and `format:check`; `typecheck` depends on `lint` and `format:check` | 9 `nx.targets` in `package.json`   |
| whatisgoingon    | same as factory; `infra` overrides `format` with `tofu fmt`                                  | 3, and `infra` adds `format:check` |
| deepagents       | one stray `format` target in `packages/compaction`                                           | 1                                  |

### Who uses it

| Consumer         | How                                                 | Record                          |
| ---------------- | --------------------------------------------------- | ------------------------------- |
| zukhruf          | `nx.json` lists the plugin by path                  | #3306 (phase 2, first consumer) |
| elt              | `nx.json` lists `@zukhruf/nx/format`                | #3318                           |
| context-compiler | `nx.json` lists `@zukhruf/nx/format`                | #3319                           |
| factory          | `nx.json` lists `@zukhruf/nx/format`                | #3320                           |
| whatisgoingon    | `nx.json` lists `@zukhruf/nx/format`                | #3321                           |
| text2sql         | `nx.json` lists `@zukhruf/nx/format`                | #3322                           |
| deepagents       | `nx.json` lists `@zukhruf/nx/format`                | #3323                           |
| offers-evals     | `nx.json` lists `@zukhruf/nx/format`                | offers-evals commit 7fd9864     |
| meddit           | `preset` writes `@zukhruf/nx/format` into `nx.json` | #4606                           |

The umbrella item is #3317.

## test

> Status: shipped (#3328).

Seven workspaces run their tests with `node --test` through Nx. Each one copies the `test` target, and the flags drifted. The `test` area is an Nx inference plugin. It gives the `test` target to each project that has `node:test` files. You list the plugin one time in `nx.json`. You do not copy the target, and you do not tag the project.

### Use the test area

You need Nx 24.0.6 or later. The peer range of `nx` and `@nx/devkit` becomes `>=24.0.6 <25`. See [Prerequisites of the test area](#prerequisites-of-the-test-area).

Add the plugin to `plugins` in `nx.json`. The options are optional. They apply to each project of the workspace:

```json
{
  "plugins": [
    "@zukhruf/nx/format",
    {
      "plugin": "@zukhruf/nx/test",
      "options": { "timeout": 300000, "flags": [] }
    }
  ]
}
```

zukhruf builds this package, so it lists the plugin by path, as it does for `format`: `"./packages/nx/src/test/plugin.ts"`.

### Signature of the test area

```ts
// @zukhruf/nx/test
export const createNodes: CreateNodes<{
  timeout?: number;
  flags?: string[];
}>;
```

Unlike `format`, this plugin takes options. The repos use different flags, so each difference is a parameter:

| Option    | Default  | Effect                                                                                                                           |
| --------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `timeout` | `300000` | the value of `--test-timeout`, in milliseconds                                                                                   |
| `flags`   | `[]`     | more Node flags for each project of the workspace, for example `["--test-force-exit"]` or `["--experimental-test-module-mocks"]` |

### Which projects get the test target

The plugin finds the test files. It does not read tags or imports. A project root gets the `test` target when all of these are true:

- The root owns at least one test file: `*.test.ts`, `*.test.mts`, `*.test.cts`, `*.test.js` or `*.test.mjs`. A file belongs to its nearest project root.
- The root has no `vitest.config.*`.
- The root has no `vite.config.*` with a `test` key. `@nx/vitest` uses the same condition (`@nx/vitest/dist/src/plugins/plugin.js:132`).
- The root is not the workspace root `.`.

The project roots are the same as for `format` (see [ADR 0003](./docs/adr/0003-which-roots-get-targets.md)). The plugin adds `**/*.test.{ts,mts,cts,js,mjs}` and `**/{vite,vitest}.config.{js,ts,mjs,mts,cjs,cts}` to the files that it reads. Thus Nx runs the plugin again when a test file or a Vite config changes. The plugin loads Vite from the workspace only for a root with a `vite.config.*`. Nx does not give the plugin the paths in `.gitignore`, so the plugin does not see `dist`.

A project with Vitest files and `node:test` files gets no `test` target from this plugin. `@nx/vitest` gives it its target, as today.

The 2026-10-29 audit of the 7 repos measured the effect. The rule matches each `node:test` target in use. 11 targets that test nothing go: in context-compiler the connectors `call-history`, `contacts`, `messages`, `slack` and `teams`; in text2sql `backend/inputs`, `harness/runs`, `toolkit/dashboards`, `reports`, `rpc` and `threads`. In text2sql, `.agents` and `.claude` get a target, because they own test files. The `test:node` tag is not necessary. A repo can delete it. See [ADR 0004](./docs/adr/0004-node-test-target-from-test-files.md).

### What the test target runs

| Part        | Value                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command     | `node "<run.js>" --test --no-warnings --test-timeout=<timeout> <flags> --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=test-results.xml --selection="<glob>"… {args}` |
| `cwd`       | `{projectRoot}`                                                                                                                                                                                                                 |
| `outputs`   | `["{projectRoot}/test-results.xml"]`                                                                                                                                                                                            |
| `cache`     | `false`                                                                                                                                                                                                                         |
| `dependsOn` | `["^build"]`                                                                                                                                                                                                                    |

- `--no-warnings`: 5 of the 7 repos use it.
- `--test-timeout`: the default is 300 s. `@zukhruf/testing` starts a shared database server the first time that a test calls `database()`, and it sets a time limit for each cold start: Postgres 60 s, MySQL and MariaDB 90 s, SQL Server 180 s. In a run, the first call of a test process also holds the reaper of the run, with a readiness bound of 60 s. One test can pay both in a row, so its own time limit must be longer than their sum. 300 s is the hold, 60 s, plus the slowest server, SQL Server 180 s, plus 60 s for the work of the test. The old default, 60 s, stopped a test before the readiness bound: on 2026-10-30 a MySQL test of text2sql and the SQL Server tests of deepagents stopped at 60 s. When `@zukhruf/testing` changes a readiness bound, change this default with it. A repo that wants a shorter limit sets the `timeout` option. One project sets `--test-timeout` in its `args`. No time limit is drift. See [ADR 0004](./docs/adr/0004-node-test-target-from-test-files.md).
- Two reporters: `spec` to the terminal and `junit` to `test-results.xml`. zukhruf, deepagents and text2sql use both.
- `^build`: a test imports the built output of the packages that the project depends on. factory, whatisgoingon and text2sql test from the source, so `^build` is sufficient for them. A repo whose tests also need the project's own `build` adds it (see [Prerequisites of the test area](#prerequisites-of-the-test-area)).
- No cache: the plugin gives `cache: false`. A repo that wants a cache sets `cache: true` in `targetDefaults.test`, which comes after the plugin. zukhruf does this since commit 03ae010f (#4831), with `{ "runtime": "node --version" }` in the `inputs`, so a new Node version runs the tests again.

The base command has no `--test-force-exit` and no `--experimental-test-module-mocks`. Only Docker tests and tests with open handles need `--test-force-exit`. Only deepagents and the text2sql electron app use module mocks. A repo adds these flags with the `flags` option. One project adds them in its own `args` (see [Override the test target of a project](#override-the-test-target-of-a-project)).

The test selection is a list of globs:

- one glob for each top-level folder that has test files, for example `"src/**/*.test.ts" "eval/**/*.test.ts"`,
- one glob with no `**` for the test files directly in the project root, for example `"*.test.ts"`, only when such files exist.

Thus a file outside these globs does not run, for example a build output or a `test/helpers/*` file with no test file next to it. Node's own default pattern, `**/{test,test/**/*,test-*,*[._-]test}.{js,mjs,cjs,ts,mts,cts}`, matches too much: `dist/spec/test/*`, `test/helpers/*` and `*.e2e.test.ts`.

### Run one file or one test

`<run.js>` is `dist/test/run.js` of this package, written relative to the project root. It starts `node` with the words of the command in their order. Each `--selection="<glob>"` is a glob of the test selection (see above).

Put the test files after `--` to run only them, as with `@nx/jest` and `@nx/vite`. A word that does not start with `-` and ends with `.test.{ts,mts,cts,js,mjs}` names test files, and a glob does too. Then the selection goes:

```sh
nx run mutex:test -- src/lock-stores/memory/memory-store.contract.test.ts
nx run mutex:test -- "src/lock-stores/**/*.test.ts"
```

`--args` does the same: `nx run mutex:test --args="src/lock-stores/memory/memory-store.contract.test.ts"`.

A Node flag keeps the selection. Use it to run the tests with a name:

```sh
nx run mutex:test --test-name-pattern=login
```

Put a flag before the files, because Node reads a flag after a file as a file name. `node --test "x.test.ts" --test-timeout=1` stops with exit code 1: `Could not find 'x.test.ts, --test-timeout=1'`. Thus `nx run mutex:test -- --test-name-pattern=login src/login.test.ts` runs the tests named `login` in `src/login.test.ts`. When the run names no files, `run.js` puts the selection after all the words, so a flag on the CLI, after `--` or in `--args` always comes before the globs.

The selection is in the command, not in `args`, because `--args` replaces `args`. Then `--args=--test-name-pattern=login` would leave Node with no file, and Node's own default pattern would run `test/helpers/*` too.

A glob that matches no file gives exit code 0. Thus a wrong narrowing passes with no test.

### Docker tests

A project with the tag `test:docker` starts Docker containers in its tests. zukhruf and deepagents already use this tag. The plugin adds three items to the `test` target of such a project:

- `--test-global-setup=<path>`. The global setup of `@zukhruf/testing` makes one run of all the test processes, and it removes what a killed run leaves.
- `--test-force-exit`. The teardown of the global setup is synchronous on purpose, so it runs also under `--test-force-exit` (`packages/testing/src/scripts/docker-global-setup.ts:99-104`).
- `cache: false`. The result depends on the engine, not only on the files.

`cache: false` is the default, not a guarantee. The base target has no cache too. `targetDefaults` and the project files come after the plugin, so a repo can set `cache: true` on both.

The plugin selects the path in this order:

1. The project's own `src/testing/docker-global-setup.ts`, if it exists. mutex has one: it starts the shared servers before the run. `@zukhruf/testing` has one: its tests use its own source.
2. Else, the file that the `./docker-global-setup` export of `@zukhruf/testing` names in its `default` condition: `dist/scripts/docker-global-setup.js`. The plugin finds the `package.json` of `@zukhruf/testing` from the project root with `module.findPackageJSON`, and reads the path from its `exports`. It does not resolve the file: `^build` builds `@zukhruf/testing` before the test, but after Nx makes the project graph, so a fresh checkout has no built file yet (commit eeea3e76, #3476). The plugin writes the path relative to the `cwd` of the target.
3. If the plugin cannot find `@zukhruf/testing`, it stops with an error: `<root> has the tag test:docker, so it needs @zukhruf/testing/docker-global-setup (install @zukhruf/testing) or a src/testing/docker-global-setup.ts of its own`. It does not run the tests with no global setup.

The value must be a path. Node resolves it with `path.resolve(cwd, value)`, so a package name does not work. That is why 5 repos keep a file that only re-exports the global setup. Each repo deletes this file when it migrates. The global setup runs one time for each `node --test` process.

The plugin does not select the Docker engine. It never sets or deletes `DOCKER_CONTEXT` or `DOCKER_HOST`, and it never calls the Docker CLI. The user, CI or the repo selects the engine. See [ADR 0005](./docs/adr/0005-docker-tests-get-the-global-setup.md).

On an SSH engine, a repo adds `--test-concurrency=1` with `flags`, or `"parallelism": false` in `targetDefaults`. The plugin does not add them.

A repo that wants a default engine for its Docker tests writes it in a task `.env` file of each Docker project, for example `.env.test` with `DOCKER_CONTEXT=limerence-dokploy` (deepagents, #3388). Nx loads the file for the `test` target, and a variable that the environment already sets wins (`nx/dist/src/tasks-runner/task-env.js:35-36`, `:177`). An empty value does not win: `dotenv-expand` 12.0.3 replaces it with the value of the file (`dotenv-expand/lib/main.js:79`). Thus CI sets `DOCKER_CONTEXT=default`, not an empty value. When `DOCKER_HOST` is set, it still selects the engine, in the Docker CLI and in `@zukhruf/docker`.

### Override the test target of a project

Nx applies the plugin first, then `targetDefaults`, then `project.json` and `package.json`. A later source wins.

A flag for each project of the workspace goes into the `flags` option. A flag for one project goes into the `args` of that project, before its own selection. `args` comes after the command, and a flag must come before a glob. For example, the text2sql backends have a time limit of 120 s:

```json
{
  "targets": {
    "test": {
      "options": { "args": "--test-timeout=120000 \"src/**/*.test.ts\"" }
    }
  }
}
```

Node uses the last `--test-timeout`, so the value in `args` wins. A probe on Node 26.10.0 showed this on 2026-10-29: `--test-timeout=50 --test-timeout=60000` passed a test of 300 ms, and the reverse order failed it.

text2sql leaves the integration tests out of `test` in the same way: `"args": "\"src/**/!(*.integration).test.ts\""`. Other flags for one project: a time limit of 10 s, `--experimental-test-module-mocks`, `--test-force-exit`, `--env-file`.

Do not override the `command`. A command in a project file is a new copy of the target.

These rules stay in their repo, because they are of a different kind:

- the script of deepagents that selects the Docker context,
- the tests of elt and context-compiler that run from the workspace root,
- the list of e2e files of the context-compiler desktop app.

A `scripts.test` in a `package.json` replaces the inferred target. Nx runs it with `nx:run-script`. The 4 demo projects of deepagents keep their scripts.

### Prerequisites of the test area

- Nx 24.0.6 or later. In Nx 23.2.1, a target default with its own `command` replaces the command of a plugin (`nx/dist/src/project-graph/utils/project-configuration/target-defaults.js:201-229`). Nx 23.1.0 does not do this. text2sql uses 23.1.0 today.
- Delete the `command` of `targetDefaults.test` in `nx.json`. If you keep it, it replaces the command of the plugin.
- Write each extra dependency with `"..."`, so that `^build` stays. For example, factory writes `["...", "^sdk"]`.
- If the tests of a project use its own built output, add `build`: `targetDefaults.test.dependsOn: ["...", "build"]`. zukhruf, deepagents, elt and context-compiler need this. For example, the tests of `@zukhruf/nx` resolve `@zukhruf/nx/format` to `dist`. Nx skips a dependency on a target that the project does not have, so this is safe for a project with no `build`.

### Migrate a workspace to the test area

1. Update `nx` and `@nx/devkit` to 24.0.6 or later.
2. Add `@zukhruf/nx/test` to `plugins` in `nx.json`. Set `timeout` and `flags` if the repo needs other values.
3. Delete the `command` of `targetDefaults.test`, and its tag filters. Write each extra dependency with `"..."`.
4. Delete each `test` target in a `project.json` or `package.json` that the plugin now gives. Move the flags of one project into its `args`.
5. Add the tag `test:docker` to each project with Docker tests.
6. Delete the file that only re-exports `@zukhruf/testing/docker-global-setup`. Keep a file that does more, for example the mutex file.
7. Delete the `test:node` tags.
8. Compare `nx show projects --withTarget test` before and after. The differences must be the ones in the table.

| Workspace        | Today                                                                                                                                             | Changes                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| zukhruf          | `targetDefaults.test` with filters `tag:test:node` and `tag:test:docker`; `dependsOn` `["build", "^build"]`; `--test-force-exit` for each project | 30 tagged projects; 2 Docker projects (mutex, testing) keep their own global setup; `dependsOn` `["...", "build"]`; no `flags`: since 2026-11-19 only the `test:docker` projects force-exit, as each other suite exits by itself (all 43 measured without the flag); since 03ae010f, `targetDefaults.test` sets `cache: true` and the inputs `["default", "^default", { "runtime": "node --version" }]` |
| factory          | 2 targets: `api` with Docker arguments; `foundation` with its tests in `tests/`                                                                   | delete `apps/factory/api/src/testing/docker-global-setup.ts`; `dependsOn` `["...", "^sdk"]`                                                                                                                                                                                                                                                                                                             |
| whatisgoingon    | 1 target                                                                                                                                          | 1                                                                                                                                                                                                                                                                                                                                                                                                       |
| deepagents       | 11 tagged projects, 3 Docker projects, 4 demo scripts                                                                                             | delete `tools/src/docker-global-setup.ts`; `dependsOn` `["...", "build"]`; module mocks in `flags` or in the `args` of a project; the 4 demo scripts and the Docker context script stay                                                                                                                                                                                                                 |
| elt              | 55 commands in the projects, 8 with the global setup                                                                                              | delete `docker-global-setup.ts`; `dependsOn` `["...", "build"]`; no override, because no test file reads a path from the working directory                                                                                                                                                                                                                                                              |
| context-compiler | 17 targets; the `plugin` project has a no-op `test` that depends on `server:test`                                                                 | 5 connector targets that test nothing go; `dependsOn` `["...", "build"]`; the desktop e2e files stay as an override; if `plugin` owns no test file, the plugin gives it nothing and its own `test` in `project.json` stays; the test target runs in the project root, so 9 test files of `cli`, `desktop` and `server` find the workspace root from `import.meta.dirname`                               |
| text2sql         | about 24 commands in the projects, and 13 projects on the shared default; Nx 23.1.0                                                               | update Nx; delete `packages/adapters/src/testing/docker-global-setup.ts` and `apps/desktop/backend/src/testing/docker-global-setup.ts`; 6 targets that test nothing go; `.agents` and `.claude` get a target; the backends set `--test-timeout=120000` in `args`; the daemon keeps `["image"]` or uses `"..."`                                                                                          |

### Who uses the test area

| Consumer         | How                                               | Record                      |
| ---------------- | ------------------------------------------------- | --------------------------- |
| zukhruf          | `nx.json` lists the plugin by path                | #3328                       |
| factory          | `nx.json` lists `@zukhruf/nx/test`                | #3363                       |
| whatisgoingon    | `nx.json` lists `@zukhruf/nx/test`                | #3364                       |
| deepagents       | `nx.json` lists `@zukhruf/nx/test`                | #3365                       |
| elt              | `nx.json` lists `@zukhruf/nx/test`                | #3366                       |
| context-compiler | `nx.json` lists `@zukhruf/nx/test`                | #3367                       |
| text2sql         | `nx.json` lists `@zukhruf/nx/test`                | #3368                       |
| offers-evals     | `nx.json` lists `@zukhruf/nx/test`                | offers-evals commit 7fd9864 |
| meddit           | `preset` writes `@zukhruf/nx/test` into `nx.json` | #4606                       |

The umbrella item is #3328.

## lint

Nx caches the `lint` target. A cached result is correct only when each file and each package that ESLint loads is an input. Seven workspaces write the packages by hand in `targetDefaults.lint.inputs`, and the lists drift: 5 to 15 packages. When a package is not in the list, an update of that package does not change the hash. Nx then replays a cached pass, and the new rules do not run.

The `lint` area is an Nx inference plugin. It adds inputs to the `lint` target that `@nx/eslint/plugin` gives. It does not make a `lint` target, and it does not change the command. It reads the packages from `@zukhruf/eslint`, so no workspace writes a list.

### Use the lint area

You need Nx 24.0.6 or later, `@nx/eslint` and `@zukhruf/eslint`. Add the plugin to `plugins` in `nx.json`, after `@nx/eslint/plugin`:

```json
{
  "plugins": [
    { "plugin": "@nx/eslint/plugin", "options": { "targetName": "lint" } },
    "@zukhruf/nx/lint"
  ]
}
```

The order is necessary. Nx merges the plugins in the order of the list, and a later plugin wins. The plugin writes `"..."` first in its `inputs`, so the inputs of `@nx/eslint/plugin` stay. If the plugin comes first, `@nx/eslint/plugin` replaces its inputs, and no run reports it. Thus the plugin stops with an error when an `@nx/eslint/plugin` entry is not before it in `plugins`. A workspace can have more than one `@nx/eslint/plugin` entry, for example with `include` and `exclude`. Then the plugin must come after each of them.

The plugin finds its own entry in `plugins` as Nx finds a plugin: it resolves each entry from the workspace root with `require.resolve` (`nx/dist/src/project-graph/plugins/in-process-loader.js:42,51`). An entry that resolves to the file of the plugin is its own entry.

zukhruf builds this package, so it lists the plugin by path, as it does for `format` and `test`: `"./packages/nx/src/lint/plugin.ts"`. A workspace that builds this package must list it by path. Nx resolves a package of the workspace by name with the `customConditions` of the root tsconfig (`nx/dist/src/project-graph/plugins/resolve-plugin.js:37-41,87-95`), and `require.resolve` does not. Then the two paths are different, and the plugin stops with the order error.

### Signature of the lint area

```ts
// @zukhruf/nx/lint
export const createNodes: CreateNodes;
```

The plugin takes no options. A workspace adds its own lint packages in `targetDefaults` (see [Add a lint package of the workspace](#add-a-lint-package-of-the-workspace)).

The name of the target is the `targetName` of each `@nx/eslint/plugin` entry. An entry with no `targetName` gives `lint`, as `@nx/eslint/plugin` does (`@nx/eslint/dist/src/plugins/plugin.js:325`).

### What the lint area adds

`@nx/eslint/plugin` already gives these inputs to `lint` (`@nx/eslint/dist/src/plugins/plugin.js:284-297`):

- `default` and `^default`,
- the root ESLint config and the ESLint config of the project,
- the `.eslintignore` of the project, when it exists,
- the tsconfig files outside the project root that the tsconfig of the project extends,
- `{workspaceRoot}/tools/eslint-rules/**/*`,
- `externalDependencies` on `eslint`.

The plugin keeps them, and it adds the packages of `@zukhruf/eslint`. It finds `@zukhruf/eslint` from the workspace root, in one of two forms:

| Form of `@zukhruf/eslint`                                           | Inputs that the plugin adds                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| an installed package in `node_modules` (each workspace but zukhruf) | `{ "externalDependencies": ["@zukhruf/eslint"] }`                                                                   |
| a package of the workspace (zukhruf)                                | the files of its `src` folder, and `externalDependencies` on each name in its `dependencies` and `peerDependencies` |

One entry is sufficient for an installed package. Nx makes a node for each package of the lockfile, with an edge for each name in `dependencies`, `peerDependencies` and `optionalDependencies` (`nx/dist/src/plugins/js/lock-file/npm-parser.js:155-170`). An input on `@zukhruf/eslint` hashes all the packages that these edges reach. Thus the hash includes each peer of `@zukhruf/eslint`, each dependency, and the packages that they load in turn. A peer that is not installed has no node, so it is not an input, and it gives no error. The hash of a package is its `integrity` in the lockfile, or its version (`npm-parser.js:103`).

A package of the workspace has no node in the lockfile. An `externalDependencies` entry with no node stops the run with an error: `The externalDependency '<name>' for '<project>:lint' could not be found`. Thus, for zukhruf, the plugin reads the names from the `package.json` of `@zukhruf/eslint`.

The plugin stops with an error in these cases. It does not give `lint` without the inputs:

- An `@nx/eslint/plugin` entry is not before the plugin in `plugins`, or `plugins` has no `@nx/eslint/plugin` entry.
- `@zukhruf/eslint` does not resolve from the workspace root.
- `@zukhruf/eslint` resolves to a folder outside the workspace and outside `node_modules`, for example after `npm link`. Nx has no node in the lockfile for such a package, so no input can hash it.

The plugin gives inputs to each project root (see [ADR 0003](./docs/adr/0003-which-roots-get-targets.md)). A project with no `lint` from `@nx/eslint/plugin` gets no `lint`: Nx deletes a target with no executor, no command and no `dependsOn` (`nx/dist/src/project-graph/utils/project-configuration/target-normalization.js:202-214`).

A probe on Nx 23.2.1 (2026-10-30) showed this:

| Order of `plugins`                    | `inputs` of the plugin                   | `lint` of the project                                                           |
| ------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------- |
| `@nx/eslint/plugin`, then this plugin | `["...", { externalDependencies }]`      | `eslint .` with the inputs of `@nx/eslint/plugin` and the new inputs            |
| `@nx/eslint/plugin`, then this plugin | `[{ externalDependencies }]`, no `"..."` | `eslint .` with only the new inputs                                             |
| this plugin, then `@nx/eslint/plugin` | with or without `"..."`                  | `eslint .` with only the inputs of `@nx/eslint/plugin`; the new inputs are lost |

In the same probe, `@zukhruf/eslint` had the peer `typescript-eslint`. A change of the version of `typescript-eslint` in the lockfile gave a new hash, and `lint` ran again. A change of the `integrity` of `globals`, a dependency of `@zukhruf/eslint`, did the same. Without the input, the same change gave a cached pass. See [ADR 0006](./docs/adr/0006-lint-inputs-from-the-eslint-package.md).

### Add a lint package of the workspace

Some configs load a package that is not in the edges of `@zukhruf/eslint`. Add it in `targetDefaults` with `"..."` first:

```json
{
  "targetDefaults": {
    "lint": {
      "inputs": [
        "...",
        {
          "externalDependencies": ["eslint-plugin-no-barrel-files"]
        }
      ]
    }
  }
}
```

`targetDefaults` comes after the plugins. Without `"..."`, its `inputs` replace the inputs of both plugins. A probe on Nx 23.2.1 (2026-10-30) showed both results.

The package above is an example from the audit: 3 project configs of text2sql load `eslint-plugin-no-barrel-files`.

`@zukhruf/eslint/react` loads 3 plugins: `@eslint-react/eslint-plugin`, `eslint-plugin-jsx-a11y-x` and `eslint-plugin-react-hooks`. `@zukhruf/eslint` declares them as optional peers. Thus they are lockfile edges of `@zukhruf/eslint`, and the plugin hashes them. Do not add them in `targetDefaults`. Import `@zukhruf/eslint/react` in each React project config. Do not use `nx.configs['flat/react']`: `@nx/eslint-plugin` does not declare the packages that it loads (`@nx/eslint-plugin/dist/src/flat-configs/react-base.js:4` and `react-jsx.js:4-6`), so they are not lockfile edges.

A local file that the root ESLint config imports is also an input of the workspace, for example `{workspaceRoot}/island.eslint.config.mjs`. Add it in the same way.

### Prerequisites of the lint area

- Nx 24.0.6 or later. The peer range of the package is `>=24.0.6 <25`.
- `@zukhruf/eslint` in the workspace.
- Delete the hand list in `targetDefaults.lint.inputs`. `targetDefaults` comes after the plugins, so a list without `"..."` replaces the inputs of the plugin.
- Keep the other keys of `targetDefaults.lint`, for example the `options.command`, `env` and `parallelism` of deepagents.
- `targetDefaults.lint` must not have `dependsOn` or a top-level `command`. Nx deletes the `lint` of the plugin on a project with no ESLint only when the target has no `executor`, no `command` and no `dependsOn` (`nx/dist/src/project-graph/utils/project-configuration/target-normalization.js:202-214`). With `dependsOn`, each project with no ESLint gets an `nx:noop` `lint` that runs the dependencies. With a top-level `command`, each such project gets a `lint` that runs the command. `options.command` is safe: Nx does not read it as a top-level `command` (`target-merging.js:15-33`).
- A `lint` target in a `project.json` with its own `executor` or `command` replaces the inputs of both plugins (`target-merging.js:443-457`). Delete such a target, or write its `inputs` with `"..."`.
- A project with no ESLint config gets no `lint` from `@nx/eslint/plugin`. If its `project.json` has its own `lint`, `"..."` keeps nothing, and the plugin inputs do not reach it. Such a target writes all its inputs: `default`, `^default`, the root ESLint config and `{ "externalDependencies": ["@zukhruf/eslint"] }`. text2sql's `apps/desktop/electron` is an example (#3389). An uncached target does not need them.

### Migrate a workspace to the lint area

1. Update `@zukhruf/nx` and `@zukhruf/eslint` to the latest release. An older `@zukhruf/eslint` does not declare the 3 plugins of `@zukhruf/eslint/react`, so its lockfile node has no edge to them. A probe on factory (Nx 24.0.1, 2026-10-30) showed this for the React plugins of that time: with `@zukhruf/eslint` 0.3.44, they were not in `external`.
2. Add `@zukhruf/nx/lint` to `plugins`, after `@nx/eslint/plugin`.
3. Delete `targetDefaults.lint.inputs`, and delete `targetDefaults.lint.dependsOn` and a top-level `targetDefaults.lint.command` (see [Prerequisites of the lint area](#prerequisites-of-the-lint-area)).
4. In each React project config, import `@zukhruf/eslint/react` instead of `nx.configs['flat/react']`.
5. If the configs load a package that is not in the edges of `@zukhruf/eslint`, add `["...", { "externalDependencies": [...] }]` (see [Add a lint package of the workspace](#add-a-lint-package-of-the-workspace)).
6. Compare `nx show target inputs <project>:lint --json` before and after, for one project of each kind. Each package of the old list must be in `external`.

| Workspace        | Packages in the hand list today | After the migration                                                                                                                                                                                                   |
| ---------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| zukhruf          | 13, and `packages/eslint/src`   | no list; `@zukhruf/eslint` is a package of the workspace                                                                                                                                                              |
| factory          | 14                              | the 5 React project configs import `@zukhruf/eslint/react`, not `nx.configs['flat/react']`; `tools/eslint-rules` goes from the list, because `@nx/eslint/plugin` gives it                                             |
| whatisgoingon    | 15                              | the same as factory, with 2 React project configs                                                                                                                                                                     |
| deepagents       | 9                               | the 4 React project configs import `@zukhruf/eslint/react`; `tsconfig.base.json` goes when the tsconfig chain gives it; `options.command`, `env` and `parallelism` stay                                               |
| text2sql         | 7                               | the 21 React project configs import `@zukhruf/eslint/react`; `eslint-plugin-no-barrel-files` (3 project configs load it) goes in `targetDefaults` with `"..."`; Nx updates from 23.1.0 first; `options.command` stays |
| elt              | 7                               | no project config; the root config gives `@zukhruf/eslint/react` to `apps/web`                                                                                                                                        |
| context-compiler | 5                               | no project config; the root config gives `@zukhruf/eslint/react` to `packages/ui`, `apps/desktop/frontend` and `apps/server/src/page`                                                                                 |

The lockfile measured the edges on 2026-10-30. For factory, whatisgoingon, deepagents and text2sql, each package of the hand list is in the edges of `@zukhruf/eslint`, except the React plugins. `@zukhruf/eslint/react` declares its 3 plugins as optional peers (#3519). An optional peer is an edge only when the workspace installs it, so the 3 plugins go in the root `devDependencies` of each React workspace.

### Who uses the lint area

| Consumer         | How                                               | Record                      |
| ---------------- | ------------------------------------------------- | --------------------------- |
| zukhruf          | `nx.json` lists the plugin by path                | #3335                       |
| factory          | `nx.json` lists `@zukhruf/nx/lint`                | #3386                       |
| whatisgoingon    | `nx.json` lists `@zukhruf/nx/lint`                | #3387                       |
| deepagents       | `nx.json` lists `@zukhruf/nx/lint`                | #3388                       |
| text2sql         | `nx.json` lists `@zukhruf/nx/lint`                | #3389                       |
| elt              | `nx.json` lists `@zukhruf/nx/lint`                | #3390                       |
| context-compiler | `nx.json` lists `@zukhruf/nx/lint`                | #3391                       |
| offers-evals     | `nx.json` lists `@zukhruf/nx/lint`                | offers-evals commit 7fd9864 |
| meddit           | `preset` writes `@zukhruf/nx/lint` into `nx.json` | #4606                       |

The umbrella item is #3335.

## opentofu

> Status: shipped (#3339).

Five projects in two workspaces run OpenTofu through Nx: the `infra` project of whatisgoingon, and four projects of text2sql (`v2-terraform`, `authx-terraform`, `desktop-terraform`, `diagnostics-terraform`). Each one copies the same targets and the same freshness script. The `opentofu` area is an Nx inference plugin. It gives the OpenTofu targets to each project that has environments. You list the plugin one time in `nx.json`. You do not copy the targets or the script.

### Use the opentofu area

You need Nx 24.0.6 or later and the `tofu` command on the `PATH`. Add the plugin to `plugins` in `nx.json`, after `@zukhruf/nx/format`:

```json
{
  "plugins": ["@zukhruf/nx/format", "@zukhruf/nx/opentofu"]
}
```

The order is necessary. Both plugins give `format` and `format:check`, and a later plugin wins the merge. In the other order, an OpenTofu project gets the Prettier targets.

A workspace that builds this package lists the plugin by path, as zukhruf does for the other areas: `"./packages/nx/src/opentofu/plugin.ts"`.

### Signature of the opentofu area

```ts
// @zukhruf/nx/opentofu
export const createNodes: CreateNodes;
```

The plugin takes no options. The commands are the same in each of the 5 copies. The differences between the copies are of a different kind, and they stay with the project (see [Give the secrets](#give-the-secrets) and [Check that a saved plan is fresh](#check-that-a-saved-plan-is-fresh)).

### Which projects get the OpenTofu targets

An **environment** is a folder `src/environments/<name>` of a project root, with at least one `*.tf` file directly in it. Each environment is one OpenTofu root module, with its own state and its own saved plan. A project root gets the OpenTofu targets when it has at least one environment. The project roots are the same as for the other areas (see [ADR 0003](./docs/adr/0003-which-roots-get-targets.md)). A `*.tf` file belongs to its nearest project root.

The plugin adds `**/src/environments/*/*.tf` to the files that it reads. Thus Nx runs the plugin again when an environment is added or removed.

Each target that works on one environment has one configuration for each environment. The options select the **default environment**: `production` when it exists, else the first environment in name order. Select another environment with `-c`:

```sh
nx run authx-terraform:preview -c staging
```

A task dependency runs with the same configuration. Thus `preview -c staging` runs `init -c staging` first.

### What each OpenTofu target runs

| Target         | Command                                                                                                                                                 | `cwd`                                   | Cached | Depends on |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------ | ---------- |
| `format`       | `tofu fmt -recursive`                                                                                                                                   | `{projectRoot}/src`                     | no     | —          |
| `format:check` | `tofu fmt -check -recursive`                                                                                                                            | `{projectRoot}/src`                     | yes    | —          |
| `typecheck`    | for each environment: `tofu -chdir=environments/<name> init -backend=false -input=false -lockfile=readonly && tofu -chdir=environments/<name> validate` | `{projectRoot}/src`                     | yes    | —          |
| `init`         | `tofu init -input=false`                                                                                                                                | `{projectRoot}/src/environments/<name>` | no     | —          |
| `preview`      | `rm -f tfplan && tofu plan -out tfplan`                                                                                                                 | the environment                         | no     | `init`     |
| `show`         | the freshness check, then `tofu show tfplan`                                                                                                            | the environment                         | no     | —          |
| `output`       | `tofu output`                                                                                                                                           | the environment                         | no     | —          |

- `format` writes. `format:check` and `typecheck` only read, as for each check ([ADR 0002](./docs/adr/0002-a-check-never-writes.md)).
- The inputs of `format:check` and `typecheck` are `{projectRoot}/src/**/*.tf`, `{projectRoot}/src/**/*.hcl` and the output of `tofu version`. The provider lock file `.terraform.lock.hcl` is an `*.hcl` file. A new release of OpenTofu thus runs the checks again.
- `typecheck` needs no secret. `init -backend=false` reads no state, and `validate` reads no variable value. CI can run it with no secret.
- `typecheck` sets `TF_DATA_DIR=.terraform/validate`. Its `init` with no backend thus does not replace the working directory of the real `init`. text2sql already does this in its 4 projects.
- `typecheck` reads the provider lock file and does not write it (`-lockfile=readonly`). When a provider is added or its version changes, `typecheck` stops: "Provider dependency changes detected". Run `nx run <project>:init`, which writes the lock file, and commit the lock file. A new hash for another platform does not stop it: OpenTofu suppresses only that write.
- `typecheck` checks each environment. `-c` does not select one.
- `init`, `preview`, `show` and `output` need the state passphrase (see [Give the secrets](#give-the-secrets)).
- `preview` deletes the old plan first. A plan that fails thus leaves no plan for `show`.
- `show` does not depend on `preview`. It shows the plan that `preview` saved, and it stops when that plan is not fresh (see [Check that a saved plan is fresh](#check-that-a-saved-plan-is-fresh)).
- Arguments after `--` go to the last command. For example, `nx run infra:output -- -raw dokploy_api` runs `tofu output -raw dokploy_api`.

The plugin gives no `apply` target, on purpose. CI applies: main is the wanted state, and the reusable workflow `tofu-apply.yml` applies it and commits the state. A person does not apply from a laptop. Two old targets also go: `plan` is the same as `preview`, and `validate` is in `typecheck`. `refresh` stays in the project that needs it, as an override. See [ADR 0007](./docs/adr/0007-opentofu-targets-from-environments-with-no-apply.md).

### Give the secrets

The state and the saved plans are encrypted. Each project reads the passphrase from the variable `tf_encryption_passphrase`. `init`, `preview`, `show` and `output` thus start with a guard. It stops the target when `TF_ENCRYPTION_PASSPHRASE` is empty or not set. Then the target gives the value to OpenTofu as `TF_VAR_tf_encryption_passphrase`.

The plugin sets no `envFile`. Nx already loads the `.env` file of the project root for each task, and `.env.<configuration>` for a task with a configuration (`nx/dist/src/tasks-runner/task-env-paths.js`). A variable that the environment already sets wins. Thus put the secrets in `<projectRoot>/.env`, and keep that file out of Git. With no `.env` file, the target reads the environment only. An `envFile` that does not exist stops the task with an error (`nx/dist/src/executors/run-commands/running-tasks.js:553-558`).

The other secrets are different in each project, so the plugin does not check them. OpenTofu reads each variable `<name>` from `TF_VAR_<name>`, and each provider reads its own token, for example `HCLOUD_TOKEN`. Give a variable with a different name in `.env`. Nx expands `${NAME}` in the file (`dotenv-expand`):

```sh
TF_ENCRYPTION_PASSPHRASE=…
DOKPLOY_API_KEY=…
HCLOUD_TOKEN=…
TF_VAR_dokploy_api_key=${DOKPLOY_API_KEY}
```

When a variable has no value, OpenTofu asks for it, or stops with "No value for required variable". The copies checked each secret in the shell first. That check predicts the error that OpenTofu already gives.

### Check that a saved plan is fresh

`show` runs the freshness check first. The check is a Node script inside this package (`src/opentofu/check-plan-fresh.ts`). The plugin gives its path relative to the environment. The check stops `show` in two cases:

- The environment has no `tfplan`. Run `preview` first.
- A file of the project changed after `preview` wrote the plan. The message names the file.

A **file of the project** is each file under the project root that Git tracks or does not ignore (`git ls-files --cached --others --exclude-standard`). A tracked file that was deleted counts as changed. A file named `tfplan` does not count. Thus the check sees each input of the plan in the project: the environment, the modules, the scripts, `project.json`, the provider lock file, the committed state, and a template such as `compose.dokploy.yml`. The `.terraform` folders, `.env` and the plans of the other environments are ignored by Git, so a new `init` does not make the plan stale.

The copies listed the inputs by name, and the lists drifted: two copies did not list `src/modules`, and two listed a compose file outside the project root, `../compose.dokploy.yml`. Each project now keeps its plan inputs inside its root. Move a template that the configuration reads into the project root.

The check needs Git. Outside a Git work tree, it stops with the error of Git. OpenTofu also refuses to apply a plan when the state changed after the plan. The check adds the files that OpenTofu does not compare.

### Override an OpenTofu target

A target in the `project.json` of a project replaces the inferred target, or merges into it. Nx applies the plugin first, then `targetDefaults`, then `project.json`. For example, a project that needs `refresh` adds it:

```json
{
  "targets": {
    "refresh": {
      "command": ": \"${TF_ENCRYPTION_PASSPHRASE:?TF_ENCRYPTION_PASSPHRASE missing}\" && TF_VAR_tf_encryption_passphrase=\"$TF_ENCRYPTION_PASSPHRASE\" tofu refresh",
      "options": { "cwd": "{projectRoot}/src/environments/production" }
    }
  }
}
```

### Migrate a workspace to the opentofu area

1. Add `@zukhruf/nx/opentofu` to `plugins` in `nx.json`, after `@zukhruf/nx/format`.
2. Delete the targets that the plugin now gives from each OpenTofu project: `init`, `format`, `format:check`, `typecheck`, `preview`, `show` and `output`. Delete `plan`, `validate` and `apply`.
3. Delete `scripts/check-plan-fresh.sh`.
4. Move the secrets with a different name to `TF_VAR_<name>` in `<projectRoot>/.env`, for example `TF_VAR_dokploy_api_key=${DOKPLOY_API_KEY}` and, for authx, `TF_VAR_otlp_headers=${AUTHX_OTLP_HEADERS}`.
5. Move a template that the configuration reads into the project root, for example `apps/v2/compose.dokploy.yml`.
6. Run `nx run <project>:typecheck`. If it stops with "Provider dependency changes detected", run `nx run <project>:init` and commit the lock file.
7. Compare `nx show project <project> --json` before and after.

| Workspace     | Projects                                                                        | Changes                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| whatisgoingon | `infra`                                                                         | `TF_VAR_dokploy_api_key` in `infra/.env`; `preview` no longer runs `typecheck` first, because `plan` validates the configuration                         |
| text2sql      | `v2-terraform`, `authx-terraform`, `desktop-terraform`, `diagnostics-terraform` | `init` no longer depends on `typecheck`; the compose files of v2 and authx move into the project roots; authx keeps its 2 environments as configurations |

### Who uses the opentofu area

| Consumer      | How                                                                                   | Record |
| ------------- | ------------------------------------------------------------------------------------- | ------ |
| whatisgoingon | `nx.json` lists `@zukhruf/nx/opentofu`, for `infra`                                   | #4612  |
| text2sql      | `nx.json` lists `@zukhruf/nx/opentofu`, for its 4 OpenTofu projects                   | #4613  |
| meddit        | the [dokploy generator](#dokploy-generator) lists `@zukhruf/nx/opentofu` in `nx.json` | #4608  |

The backlog item of the area is #3339.

## prisma

> Status: shipped (#3339).

Six projects in two workspaces run Prisma through Nx: `@factory/db` of factory, and five projects of text2sql (`v2-db`, `authx-db`, `desktop-db`, `db` and `@workspace/amail`). Each one copies a cached `generate` target, and five also copy the migrate targets. The `prisma` area is an Nx inference plugin. It gives the Prisma targets to each project with a `prisma.config.ts`. You list the plugin one time in `nx.json`.

### Use the prisma area

You need Nx 24.0.6 or later, and `prisma` and `@prisma/client` in the lockfile. Add the plugin to `plugins` in `nx.json`. Then add `generate` to the `dependsOn` of `typecheck` and `build` in `targetDefaults`:

```jsonc
{
  "plugins": ["@zukhruf/nx/prisma"],
  "targetDefaults": {
    "typecheck": {
      "dependsOn": ["lint", "format:check", "generate", "migrate:check", "..."],
    },
    "build": {
      "dependsOn": ["generate", "..."],
    },
  },
}
```

Keep the entries that are already in the lists. Nx skips a `dependsOn` on a target that the project does not have, so a project with no Prisma is not changed. `migrate:check` of a Postgres schema needs Docker and `@zukhruf/testing` (see [Check the migrations](#check-the-migrations)). The plugin does not change `typecheck` or `build`. Those targets belong to other plugins, as for `format:check` ([ADR 0001](./docs/adr/0001-inferred-targets-not-copied-defaults.md)). The `typecheck:generate` tag of text2sql is then not necessary. See [ADR 0008](./docs/adr/0008-prisma-targets-from-prisma-config-with-outputs-from-the-schema.md).

### Signature of the prisma area

```ts
// @zukhruf/nx/prisma
export const createNodes: CreateNodes;
```

The plugin takes no options. The commands are the same in each copy. The output folder of `generate` is different in each project, and the schema already gives it.

### Which projects get the Prisma targets

A project root gets the Prisma targets when it has a `prisma.config.ts` directly in it. Prisma 7 reads its config from that file. The project roots are the same as for the other areas (see [ADR 0003](./docs/adr/0003-which-roots-get-targets.md)). The plugin also reads the `*.prisma` files of the project. A `*.prisma` file belongs to its nearest project root.

### What each Prisma target runs

Each target runs in `{projectRoot}`.

| Target           | Command                                                                                                                                         | Cached | Depends on |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| `generate`       | `prisma generate`                                                                                                                               | yes    | —          |
| `migrate`        | `prisma migrate dev`                                                                                                                            | no     | `generate` |
| `migrate:check`  | `prisma migrate diff --from-migrations migrations --to-schema . --exit-code`, on a shadow database                                              | yes    | —          |
| `migrate:create` | `prisma migrate diff --from-migrations migrations --to-schema . --script --output migrations/<time>_<name>/migration.sql`, on a shadow database | no     | —          |
| `deploy`         | `prisma migrate deploy`                                                                                                                         | no     | —          |
| `reset`          | `prisma migrate reset`                                                                                                                          | no     | —          |
| `pull`           | `prisma db pull`                                                                                                                                | no     | —          |

- The inputs of `generate` are `{projectRoot}/**/*.prisma`, `{projectRoot}/prisma.config.ts`, and the packages `prisma` and `@prisma/client` (`externalDependencies`). Thus a new model file in `models/` runs `generate` again, and an update of Prisma does too. The copies had the whole `package-lock.json` as an input, so each update of any package ran `generate` again.
- The outputs of `generate` are the `output` folders of the `generator` blocks in the `*.prisma` files of the project. A path is relative to the file of its block, as Prisma reads it. For example, `output = "src/prisma"` in `schema.prisma` gives `{projectRoot}/src/prisma`. Nx restores these folders from the cache.
- When a `generator` block has no `output`, Prisma writes into `node_modules`. The plugin then gives `generate` with no cache, because Nx cannot restore that folder.
- `migrate`, `reset` and `pull` change the database or the schema. Run them on purpose. No target depends on them.
- Prisma reads the connection string. `prisma.config.ts` reads it from the environment, and Nx loads the `.env` file of the project root for each task.

text2sql also has a target `prisma` that runs the Prisma CLI with the arguments that you give. It stays in each project that wants it.

### Check the migrations

`migrate:check` fails when the migrations in `migrations/` do not build the schema of the project folder: a model changed with no migration, or a migration with no change of the models. It prints Prisma's diff from the migrations to the schema. `migrate:create` writes that diff as a new migration:

```sh
npx nx run @acme/db:migrate:create --name add_patient_age
npx nx run @acme/db:migrate:check
```

- Both run `src/prisma/migrate-diff.ts` of this package. The script reads the `provider` of the `datasource` block of the schema, and the shadow database follows it:
  - `postgresql`: the script takes a new, empty database from `@zukhruf/testing/postgres`, gives it to Prisma as `SHADOW_CONNECTION_STRING`, and drops it after the diff. Prisma replays the migrations there. So the targets need Docker and `@zukhruf/testing`, as the tests of a db package do, and no `.env` entry, dev database or CI step. A `SHADOW_CONNECTION_STRING` in `.env` or in the shell is not used, so its database is never emptied. `prisma.config.ts` must read `datasource.shadowDatabaseUrl` from `SHADOW_CONNECTION_STRING`, as the [prisma generator](#prisma-generator) writes it. Else Prisma stops with "You must set `datasource.shadowDatabaseUrl`".
  - `sqlite`: the script sets no `SHADOW_CONNECTION_STRING` and starts no database. With no shadow URL, Prisma replays the migrations on an in-memory SQLite database. The targets need no Docker and no `@zukhruf/testing` (#5625).
  - Another provider: the script stops before Prisma with an error that names the provider.
- The schema is the project folder (`--to-schema .`), with each `*.prisma` file under it, as `schema: '.'` of the generated config. A diff to `schema.prisma` alone removes every table that `models/*.prisma` holds.
- The folder name of `migrate:create` is the UTC time to the second and the name, as `prisma migrate dev` names it. With no change, the file is `-- This is an empty migration.`, for SQL that you write. `migrate:create` needs no TTY and no dev database, where `migrate dev --create-only` refuses a data-loss warning with no TTY. Its SQL can still fail on a table with rows, for example a required column with no default: edit it before `deploy`.
- `migrate:check` is cached on the `*.prisma` files, `prisma.config.ts`, the migrations and the package `prisma`. The [prisma generator](#prisma-generator) adds it to `targetDefaults.typecheck.dependsOn`. See [ADR 0018](./docs/adr/0018-migrate-check-diffs-the-migrations-on-a-shadow-database-that-it-makes.md).

### Migrate a workspace to the prisma area

1. Add `@zukhruf/nx/prisma` to `plugins` in `nx.json`.
2. Add `generate` to `targetDefaults.typecheck.dependsOn` and `targetDefaults.build.dependsOn`. Add `migrate:check` to `targetDefaults.typecheck.dependsOn`, as the [prisma generator](#prisma-generator) does (commit 19a4bd37, `src/generators/prisma/generator.test.ts`). `migrate:check` of a Postgres schema needs Docker and `@zukhruf/testing` (see [Check the migrations](#check-the-migrations)).
3. Delete `generate`, `migrate`, `deploy`, `reset` and `pull` from each Prisma project, and the `typecheck` entry that only adds `generate`.
4. Delete the `typecheck:generate` tag and its `targetDefaults` filter.
5. Compare `nx show project <project> --json` before and after.

| Workspace | Projects                                      | Changes                                                                                                                       |
| --------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| factory   | `@factory/db`                                 | the project gets `reset` and `pull`; `build` gets `generate` from `targetDefaults`                                            |
| text2sql  | `v2-db`, `authx-db`, `desktop-db`, `db`       | `migrate` depends on `generate`, not on `build`; `desktop-db` gets `deploy`; `bundle` keeps its own `dependsOn` on `generate` |
| text2sql  | `@workspace/amail` (`tools/playground/amail`) | it has a `prisma.config.ts`, so it gets the targets too; its `generate` in `package.json` goes; the output is `prisma/client` |

### Who uses the prisma area

| Consumer | How                                                                               | Record |
| -------- | --------------------------------------------------------------------------------- | ------ |
| text2sql | `nx.json` lists `@zukhruf/nx/prisma`                                              | #4613  |
| meddit   | the [prisma generator](#prisma-generator) lists `@zukhruf/nx/prisma` in `nx.json` | #4607  |
| factory  | not yet: its `nx.json` does not list `@zukhruf/nx/prisma`                         | #4611  |

The backlog item of the area is #3339.

## migrations

A change to what a generator writes reaches a repo that ran the generator before through an Nx migration, when someone runs:

```sh
npx nx migrate @zukhruf/nx@latest
npx nx migrate --run-migrations
```

`nx migrate` moves every published @zukhruf package with `@zukhruf/nx` (`packageGroup`), and nothing runs the migrations otherwise. Each one adds only what is missing, writes what the generators write now, and logs the step to take by hand where a file lost the shape that the generator wrote. `packageJsonUpdates` in `migrations.json` move each third-party peer that the generators install to its pin in `versions.ts`, in the root package.json of a repo that has it, so a narrower peer range does not stop npm, and `move-peers-in-project-manifests` moves the same packages in each project's package.json that declares them, so the root and the apps install one copy. [ADR 0017](./docs/adr/0017-nx-migrations-bring-a-change-of-generated-output-to-the-repos-that-ran-the-generator-before.md) has the rules.

| Migration                         | Version | Brings                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add-portless-proxy-env`          | 0.8.40  | `PORTLESS_UNPRIVILEGED=1` and `PORTLESS_HTTPS=1` in `targetDefaults.portless` (#4768)                                                                                                                                                                                                                          |
| `add-local-postgres`              | 0.8.40  | the root `compose.dev.yml`, `up` and `down` of each db package, the local `CONNECTION_STRING`, and `^up` in its backend serve (ADR 0012 decisions 16 and 17)                                                                                                                                                   |
| `node-env-production`             | 0.8.40  | the NODE_ENV configuration of ADR 0016 (nx.json defaults, target env, the web exceptions, `.env.example`, the workflow env, `ALLOWED_ORIGINS`), and a log of each NODE_ENV read in source                                                                                                                      |
| `add-prisma-client-inputs`        | 0.8.40  | `...` and `{ "dependentTasksOutputFiles": "**/*.ts" }` in the `inputs` of `targetDefaults.typecheck` and `.build` of a repo with `@zukhruf/nx/prisma`, so a schema change rebuilds the db package (#4826); since 0.8.60 it writes the rule of ADR 0019                                                         |
| `add-migrate-check`               | 0.8.44  | `migrate:check` in `targetDefaults.typecheck.dependsOn` of a repo with `@zukhruf/nx/prisma`, so the typecheck of a db package fails when its migrations do not build its schema (#4937, ADR 0018)                                                                                                              |
| `add-generated-source-defaults`   | 0.8.60  | the rule of ADR 0019 in a repo whose `nx.json` lists the three plugins of `init`; removes the `dependsOn: ["^sdk"]` of a web `test` target; logs each other target that hides the rule (#5219)                                                                                                                 |
| `add-sdk-build-edges`             | 0.8.69  | `build-deps` in each node-app backend; `implicitDependencies` on the backend, `dependsOn: ["^build-deps"]` and the inputs of ADR 0021 in its client's `sdk`; when either file is not the one `node-app` wrote, or the client has no stub, changes neither and logs both edits (#5102)                          |
| `rename-eslint-react-config`      | 0.8.66  | `zukhruf.configs['shadcn']` for `zukhruf.configs['react']` or `.react` (whatever the default import of `@zukhruf/eslint` is called) and `'zukhruf/shadcn'` for `'zukhruf/react'` in an `extends` array, in each `eslint.config.*`; `@zukhruf/eslint/react` stays; logs each edit (#5263, ADR 0017 decision 10) |
| `move-peers-in-project-manifests` | 0.8.70  | the versions of `packageJsonUpdates` in each project's package.json that declares the package, in its section, never down, never into a project without it; logs each move (#5296, ADR 0017 decision 9)                                                                                                        |

## release

The release block of `nx.json` was the same in zukhruf, elt, deepagents and sdk-it. The file `@zukhruf/nx/release.json` gives that block one time, and `nx.json` extends it (#4677, commit 001377af):

```json
{
  "extends": "@zukhruf/nx/release.json"
}
```

Nx's `extends` is a shallow merge (commit 001377af). A `release` key in the `nx.json` of the workspace replaces the whole block of the file.

| Field                                      | Value                                              | What it does                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects`                                 | `["tag:npm:public"]`                               | Releases only the projects with the tag `npm:public`.                                                                                                     |
| `conventionalCommits.types.refactor`       | `{ "semverBump": "patch" }`                        | A `refactor` commit makes a patch version.                                                                                                                |
| `changelog.workspaceChangelog.file`        | `false`                                            | Writes no changelog file for the workspace.                                                                                                               |
| `version.preVersionCommand`                | `nx run-many -t build --projects=tag:npm:public`   | Builds the released projects before Nx writes the versions.                                                                                               |
| `version.conventionalCommits`              | `true`                                             | Takes the next version from the conventional commits.                                                                                                     |
| `version.preserveMatchingDependencyRanges` | `false`                                            | Writes the new version into each dependency range, also into a range that matches it.                                                                     |
| `version.git`                              | `{ "commit": false, "tag": false, "push": false }` | Writes the versions into the checkout only: no commit, no tag and no push. The release job tags the pushed commit through the GitHub API (root ADR 0008). |
| `releaseTag.pattern`                       | `release/{version}`                                | Names each tag `release/<version>`, such as `release/0.8.40`.                                                                                             |

zukhruf ([nx.json](../../nx.json)) and deepagents extend the file. Their release workflows run zukhruf's `nx-release-version` action, which passes the same git switches, and the `preVersionCommand` builds the `tag:npm:public` packages before the versions change; zukhruf's `release-tag` action then makes the tag `release/<version>` on the pushed commit (root ADR 0008, #4985).

## generators

The root files of a workspace are the same in each repo: `package.json`, `nx.json`, the tsconfig files, `.npmrc`, the Git hooks and more (see [monorepo standard](#monorepo-standard)). factory writes them with the `workspace` generator of its private package `@factory/foundation`. Other repos copy them by hand: 3 to 7 copies of each file. meddit is the third repo that starts from the standard, so the generator moves here (#3259).

The package gives two Nx generators:

- `preset` starts a repo. `create-nx-workspace` runs it.
- `init` adds the root files of the standard to an Nx workspace. It is safe to run again. `nx add @zukhruf/nx` runs it.

The generators write only the root files that each repo needs. The wiring of one kind of app (Hono, React, Vite, Tailwind, Vitest) comes from the app generators `node-app`, `react-app`, `pair` and `ui-package` (#3338).

### Start a repo in a new folder

```sh
npx create-nx-workspace@latest <name> --preset=@zukhruf/nx --pm=npm --nxCloud=skip --aiAgents=none
```

The name is the folder name, and the scope of the workspace. `acme` gives the folder `acme` and the root package `@acme/source`.

### Start a repo in an empty Git repo

Give `.` as the name, in the folder of the repo:

```sh
cd ~/Desktop/mo/meddit
npx create-nx-workspace@latest . --preset=@zukhruf/nx --pm=npm --nxCloud=skip --aiAgents=none
```

This is the path for meddit, which has only `.git`. Nx 24 supports it, and no step deletes the folder or `.git`:

- `.` gives the name of the current folder, and the parent folder as the working folder (`create-nx-workspace/dist/bin/create-nx-workspace.js:612-617`, 24.0.6). The folder must exist, so the "directory exists" check does not apply (`:646-660`).
- `nx new` then gets `skipEmptyDirCheck`, so it writes into a folder that is not empty (`create-nx-workspace/dist/src/create-empty-workspace.js:31-37`; the check is at `@nx/workspace/dist/src/generators/new/new.js:68-73`).
- An Nx generator writes files through a `Tree`. It never removes a folder that it did not write, so `.git` stays.
- In a folder that is already a Git work tree, create-nx-workspace runs no `git init`, no `git add` and no commit (`create-nx-workspace/dist/src/utils/git/git.js:141-149`). The first commit is yours.

A smoke test on 2026-11-18 ran this command with the `@zukhruf/nx` preset in a folder with only `git init` (see [Test the preset](#test-the-preset)). The folder and `.git` stayed, `git log` showed no commit, `git status` showed each file as new, `core.hooksPath` was `.husky`, and the first commit passed the hooks. The preset `npm` behaves differently: create-nx-workspace maps it to the template flow for an agent (`bin/create-nx-workspace.js:362-380`), and that flow amends the README and can leave an `error.log` (`create-workspace.js:269-288`).

Two other seams do not work for an empty repo:

- `nx g @zukhruf/nx:init` needs a workspace. With no `nx.json`, Nx prints "The current directory isn't part of an Nx workspace" and stops with exit code 1 (`nx/dist/bin/nx.js:63`, `:108-110`, `:151-167`).
- `nx init` in a folder with no `package.json` sets up Nx for a repo that is not JavaScript: a `.nx/installation` folder and an `nx` wrapper script (`nx/dist/src/command-line/init/init-v2.js:137-141`). That is not an npm workspace.

The flags:

| Flag              | Why                                                                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--pm=npm`        | The standard uses npm workspaces only. The preset stops with an error for another package manager.                                                                                                                            |
| `--nxCloud=skip`  | No repo uses Nx Cloud.                                                                                                                                                                                                        |
| `--aiAgents=none` | Without it, create-nx-workspace detects the agent and writes `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json` and more before the preset runs (`@nx/workspace/dist/src/generators/new/generate-workspace-files.js:146-153`). |

In a terminal, create-nx-workspace asks you to trust the third-party preset. An agent or CI run does not ask (`create-nx-workspace/dist/src/internal-utils/prompts.js:194-208`).

### What create-nx-workspace runs

For a preset from npm, create-nx-workspace runs these steps in order:

1. It installs `nx` and `@nx/workspace` at its own version in a temporary folder (`create-nx-workspace/dist/src/create-sandbox.js:18-29`).
2. It runs `nx new` there. `nx new` writes `package.json`, `nx.json`, `.gitignore`, `.editorconfig`, `.vscode/extensions.json` and `README.md`, adds `@zukhruf/nx` to `dependencies`, and runs `npm install` (`@nx/workspace/dist/src/generators/new/new.js:12-35`, `generate-workspace-files.js:119-176`, `generate-preset.js:271-276`). The root `package.json` gets `nx` and `@nx/workspace` at the version of create-nx-workspace, and a `packageManager` key (`generate-workspace-files.js:132-135`).
3. It runs `nx g @zukhruf/nx:preset` in the new folder, with the options of the command line (`create-nx-workspace/dist/src/create-preset.js:8-38`).
4. It runs `nx format --all` when the workspace has a formatter (`create-nx-workspace/dist/src/create-workspace.js:158-196`).
5. It runs `git init` and the first commit, but only when the folder is not a Git work tree (step 4 of the list above).

`NX_SKIP_FORMAT=true` is set from step 2 to step 3 (`create-workspace.js:36-41`), so the `formatFiles` of the preset does nothing there (`@nx/devkit/dist/src/generators/format-files.js:40-44`). Step 4 formats all the files with the `.prettierrc` that the preset wrote.

### Add the standard to an Nx workspace

```sh
npx nx add @zukhruf/nx
```

`nx add` installs the package and runs its `init` generator (`nx/dist/src/command-line/init/configure-plugins.js:61-87`, 24.0.6). When the package is already installed, run the generator itself:

```sh
npx nx g @zukhruf/nx:init
```

Run it in a workspace that has `nx.json` and `@zukhruf/nx`. It writes each missing root file and each missing key. It keeps what is there. A second run changes nothing.

### Signature of the generators

```jsonc
// packages/nx/generators.json, named by "generators" in package.json
{
  "generators": {
    "preset": {
      "implementation": "./dist/generators/preset/generator.js",
      "schema": "./src/generators/preset/schema.json",
      "description": "Start a repo of the monorepo standard. create-nx-workspace runs it.",
    },
    "init": {
      "implementation": "./dist/generators/init/generator.js",
      "schema": "./src/generators/init/schema.json",
      "description": "Add the root files of the monorepo standard. Safe to run again.",
    },
  },
}
```

```ts
// @zukhruf/nx:preset
interface PresetOptions {
  name: string; // the folder name, from create-nx-workspace
  packageManager?: string; // anything other than 'npm' is an error
}

// @zukhruf/nx:init
type InitOptions = Record<string, never>;
```

- The schema of `preset` does not set `additionalProperties: false`. create-nx-workspace passes each option of its command line to the preset, for example `preset`, `defaultBase`, `workspaces` and `aiAgents` (`create-preset.js:9-17`). Nx stops with "'x' is not found in schema" only when the schema sets `additionalProperties: false` (`nx/dist/src/utils/params.js:175-185`). The preset reads `name` and `packageManager`, and ignores the others.
- `package.json` gets `"generators": "./generators.json"`, and `files` adds `generators.json` and `src/generators/*/schema.json`. `tsc` builds only `.ts` files, so the content of each file that a generator writes is a string in a `.ts` module, not a file in a `files/` folder. Then `dist` has it, and no build step copies assets.
- `init` takes no options, as `format` and `lint` take none. The workspace scope comes from the root package name (see [The workspace scope](#the-workspace-scope)). Each difference between the copies is the wiring of one kind of app, and the app generators own it.

### What the generators write

`init` writes a file in one of three ways:

- **Create**: it writes the file only when it is missing, and never changes it later.
- **Add lines**: it adds each missing line, and never removes or reorders a line.
- **Merge keys**: it sets the keys that the standard owns, and keeps the other keys.

`preset` runs just after `nx new`, so it knows that each file in the folder came from `nx new`. It replaces 4 files of `nx new` with the files of the standard, and it cleans `package.json`. It deletes `apps/.gitkeep` and `libs/.gitkeep`, which `nx g` writes into the `Tree` before it calls a generator named `preset` (`nx/dist/src/command-line/generate/generate.js:250-253`). Then it runs `init`.

| File                                                   | Content                                                                                                                                                                                                                                                                                                                                                                                                                            | `init`     | `preset`                                                                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json`                                         | `private: true`, `type: "module"`, `workspaces: ["apps/*", "packages/*", "tools/*"]` when missing, `scripts.prepare: "git config core.hooksPath .husky \|\| exit 0"` when missing, the root `devDependencies` (see [Versions](#versions-that-the-generators-write)), `allowScripts` for the packages it installs                                                                                                                   | merge keys | also deletes `packageManager`, the empty `dependencies` and `@nx/workspace`; moves `@zukhruf/nx` from `dependencies` to `devDependencies`; `name` stays `@<name>/source` |
| `nx.json`                                              | `analytics: false`; `tui.enabled: false`; `namedInputs` `default`, `production` (with `{ "env": "NODE_ENV" }`, without the ESLint config, the tests and the test tsconfigs) and `sharedGlobals` (the root ESLint config, `tsconfig.base.json`); `plugins` in this order: `@nx/js/typescript`, `@nx/eslint/plugin`, `@zukhruf/nx/lint`, `@zukhruf/nx/format`, `@zukhruf/nx/test`; `targetDefaults` below; `sync.applyChanges: true` | merge keys | —                                                                                                                                                                        |
| `tsconfig.base.json`                                   | the base for bundled apps (`moduleResolution: "Bundler"`, `strict`, `verbatimModuleSyntax`, `erasableSyntaxOnly`), with `noUncheckedIndexedAccess`; `tsconfigBase` in [`files.ts`](./src/generators/init/files.ts)                                                                                                                                                                                                                 | create     | —                                                                                                                                                                        |
| `tsconfig.json`                                        | the solution file: `extends` the base, `files: []`, `references: []`; `nx sync` writes the references                                                                                                                                                                                                                                                                                                                              | create     | —                                                                                                                                                                        |
| `.npmrc`                                               | `legacy-peer-deps=false`, `save-exact=true`, `strict-allow-scripts=true`                                                                                                                                                                                                                                                                                                                                                           | add lines  | —                                                                                                                                                                        |
| `.nvmrc`                                               | `lts/*`                                                                                                                                                                                                                                                                                                                                                                                                                            | create     | —                                                                                                                                                                        |
| `.gitattributes`                                       | `* text=auto eol=lf`                                                                                                                                                                                                                                                                                                                                                                                                               | create     | —                                                                                                                                                                        |
| `.editorconfig`                                        | utf-8, lf, a final newline, 2 spaces, trim trailing whitespace except in `*.md`                                                                                                                                                                                                                                                                                                                                                    | create     | replaces the file of `nx new`                                                                                                                                            |
| `.gitignore`                                           | `gitignore` in [`files.ts`](./src/generators/init/files.ts)                                                                                                                                                                                                                                                                                                                                                                        | add lines  | replaces the file of `nx new`                                                                                                                                            |
| `.prettierrc`                                          | single quotes, the sort-imports plugin, `importOrder` with `./env` and `./startup` first and `^@<scope>/(.*)$`, and no Tailwind plugin                                                                                                                                                                                                                                                                                             | create     | —                                                                                                                                                                        |
| `.prettierignore`                                      | `prettierignore` in [`files.ts`](./src/generators/init/files.ts)                                                                                                                                                                                                                                                                                                                                                                   | add lines  | —                                                                                                                                                                        |
| `eslint.config.mjs`                                    | `flat/base`, `flat/typescript` and `flat/javascript` of `@nx/eslint-plugin`; the build-output `ignores`; `@nx/enforce-module-boundaries`; the `base`, `tests`, `diagnostics`, `env`, `nx-project-json` and `github-actions` configs of `@zukhruf/eslint`; `manifest.configs.recommended`; Modern Node for the config files and `.husky/*.ts`; `allowDefaultProject` for `*.config.ts` and `.husky/*.ts`                            | create     | —                                                                                                                                                                        |
| `.husky/pre-commit.ts`, `pre-push.ts`, `commit-msg.ts` | `Sync`, `Format`, `NoNumericPins`, `NpmrcPolicy`, `LockfileSync`, `OneRuntimeCopy`, `InstallScriptsReviewed`, `DockerfileInstallsFromLockfile`, `DependencyChecks` and `WorkflowChecks` on pre-commit, `Build` with `NODE_ENV=production` on pre-push, `NxReleaseScope` on commit-msg; mode `755`                                                                                                                                  | create     | —                                                                                                                                                                        |
| `.husky/pre-commit`, `pre-push`, `commit-msg`          | a link to the `.ts` file of the same name                                                                                                                                                                                                                                                                                                                                                                                          | create     | —                                                                                                                                                                        |
| `.vscode/settings.json`                                | file nesting, watcher and search excludes for `node_modules`, `.nx`, `tmp`                                                                                                                                                                                                                                                                                                                                                         | create     | —                                                                                                                                                                        |
| `.vscode/extensions.json`                              | `nrwl.angular-console`, `esbenp.prettier-vscode`, `dbaeumer.vscode-eslint`                                                                                                                                                                                                                                                                                                                                                         | create     | replaces the file of `nx new`                                                                                                                                            |
| `AGENTS.md`, `CLAUDE.md`                               | `AGENTS.md` holds the commands of the agent workflow; `CLAUDE.md` is one line, `@AGENTS.md`                                                                                                                                                                                                                                                                                                                                        | create     | —                                                                                                                                                                        |
| `README.md`                                            | `# <name>` and a link to `AGENTS.md`                                                                                                                                                                                                                                                                                                                                                                                               | —          | replaces the file of `nx new`                                                                                                                                            |

The `targetDefaults` that `init` writes:

| Target                                      | Default                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typecheck`                                 | `dependsOn: ["lint", "format:check", "..."]`; `"..."` keeps the `^typecheck` of `@nx/js/typescript`                                                                       |
| `dev`, `serve`, `preview`, `serve-static`   | `continuous: false`; Nx reports a continuous task that no task depends on as a success, whatever its exit code                                                            |
| `typecheck`, `build`, `test`, `lint`, `dev` | `dependsOn` gets `"generate"`, `"^sdk"` and `"..."`, and `lint` also `"^build"`: a task that reads generated code runs its generator first (ADR 0019)                     |
| `typecheck`, `build`, `lint`                | `inputs` gets `"..."` and `{ "dependentTasksOutputFiles": "**/*.ts" }`: Nx hashes no gitignored file, so the task hashes the generated code as an output of the generator |
| `test`, `serve`                             | `options.env.NODE_ENV: "production"` (ADR 0016); a `NODE_ENV` that is there stays, and a project target with its own `options.env` replaces it                            |

It writes no `format` or `format:check` default, and no `lint` or `test` default but the entries above. The `format`, `lint` and `test` areas give those targets, and a default with more would replace them (see the sections above). Not `build`: the backend build runs the `@nx/esbuild` executor, whose schema may refuse an `env` option.

### What only an app generator writes

A root file holds no wiring of one kind of app. A pattern that matches no file is not wiring: the root `.gitignore`, `.prettierignore` and ESLint `ignores` keep `.sdk-it` and the Vite timestamp files, and the first two `importOrder` entries (`./env`, `./startup`) stay in `.prettierrc`.

| Wiring                                                                                                                                   | Generator                    |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `@nx/node` and `@nx/esbuild`; the `@nx/esbuild:esbuild` target default; `generators["@nx/node"]`                                         | `node-app` (#3338)           |
| `!{projectRoot}/sdk-it.config.*` in `production`; the rule of `init` in the `@nx/esbuild:esbuild` default (ADR 0019)                     | `node-app` (#3338)           |
| the `hono` config of `@zukhruf/eslint` and the `env` settings, in the project's own `eslint.config.mjs`                                  | `node-app` (#3338)           |
| `Dockerfile`, `.dockerignore`, `esbuild: true` in `allowScripts`                                                                         | `node-app` (#3338)           |
| `@nx/react`, `@nx/vite`, `@nx/vitest`, Vite, Vitest, Testing Library, happy-dom; `generators["@nx/react"]`                               | `react-app` (#3338)          |
| `@zukhruf/eslint/react` and its 3 optional peers; the `react-router` and `tailwind` configs, in the project config                       | `react-app` (#3338)          |
| Tailwind, `prettier-plugin-tailwindcss` in `.prettierrc` `plugins`, the Tailwind sync generator in `sync` and in `build`, `dev`, `serve` | `react-app` (#3338)          |
| `allowDefaultProject` for `sdk-it.config.ts` and `prisma.config.ts`, in the project config                                               | `node-app`, `prisma` (#4604) |

The Git hooks are the same in each repo. `Sync` stages `**/tsconfig*.json` and `**/styles.css`: it stages only a file that a sync generator wrote, so the second glob matches nothing in a repo with no Tailwind.

### Versions that the generators write

- **The Nx family has one exact version.** `init` sets the root `nx` and each root `@nx/*` to `nxVersion`, also when the version is already there and is another one, a newer one included. Then npm installs one `nx` (#4532). An app generator adds its `@nx/*` packages at the same `nxVersion`. A test checks that the root `nx` equals `nxVersion` after `preset`, and that no root `@nx/*` has another version.
- **A missing `@zukhruf/*` package gets the version of `@zukhruf/nx` itself.** nx release gives each public package of zukhruf the same version, so the generator reads its own `package.json` and writes no list of versions. A version that is already there stays.
- **The other root tools have exact versions** from one module, `src/generators/versions.ts`, that the app generators share: TypeScript 7 as `@typescript/native: "npm:typescript@7.x"` and the TypeScript 6 API as `typescript: "npm:@typescript/typescript6@6.x"` (see [Decisions and their reasons](#decisions-and-their-reasons)), ESLint 10, Prettier 3, `@trivago/prettier-plugin-sort-imports`, and the peers of `@zukhruf/eslint` that the root config loads. `init` adds a missing package at that version, and keeps a version that is already there.
- **`allowScripts`** names each install script of a package that the generator installs: `nx: false` and `unrs-resolver: false`. `init` adds a missing name, and keeps a decision that is already there. The smoke test of 2026-11-18 proved the list: `npm install` with `strict-allow-scripts=true` passed.

### The workspace scope

The root package name is `@<scope>/source`. `nx new` writes it from the folder name (`@nx/workspace/dist/src/generators/new/files-integrated-repo/package.json__tmpl__`). One function reads the scope from that name, and each generator calls it: the `importOrder` of `.prettierrc` here, and the name of a generated client (`@<scope>/<app>-client`) and the portless domain in `node-app` (#3338). That is 3 places (#4080). The function stops with an error when the name has no scope. A generator never writes a fallback scope, so no repo gets the scope of another repo (factory falls back to `@factory`).

### Install the dependencies and the hook links

A generator returns its install as a callback. Nx runs the callback after it writes the files, and not in a dry run.

- Both generators return `runTasksInSerial(installPackagesTask(tree), linkHooks)` (`@nx/devkit/dist/src/generators/run-tasks-in-serial.js:9-15`, `@nx/devkit/dist/src/tasks/install-packages-task.js:15-42`). `installPackagesTask` runs `npm install` only when the generator changed `package.json`, so a second run of `init` installs nothing.
- After `preset`, `nx format --all` of create-nx-workspace finds Prettier and the sort-imports plugin installed.

The `Tree` keeps a file mode, but it has no links:

- **Mode.** The generator calls `tree.changePermissions('.husky/<hook>.ts', '755')` after `formatFiles`. `formatFiles` writes each file again with no options, so a mode set before it is lost (`@nx/devkit/dist/src/generators/format-files.js:119`; `nx/dist/src/generators/tree.js:45-68`). Nx applies the mode when it writes the file (`tree.js:185-211`, `:279-292`).
- **Links.** Git runs `.husky/pre-commit`, so `.husky/pre-commit` is a link to `pre-commit.ts`. The `Tree` cannot write a link, so the callback writes each missing link with `fs.symlink`.

`prepare` sets `core.hooksPath` when npm installs. In an empty Git repo, the install of the preset runs it. In a new folder, `git init` comes after the install, so the first `npm install` after create-nx-workspace sets it.

### What the generators do not do

- **They do not write CI, deploy or infra files.** The `dokploy` generator writes them (#4603).
- **They do not write a NodeNext base.** The base is the one for bundled apps. zukhruf and elt run code from source with NodeNext, and they do not use the generators.
- **They do not change an ESLint config that is already there.** factory splices the configs of `@zukhruf/eslint` into an existing `eslint.config.mjs`. No consumer needs that now: the generator writes the file in a new repo, and factory and whatisgoingon already have their config.
- **They do not commit.** create-nx-workspace commits only in a new folder. In an existing repo, you make the first commit.
- **They do not delete a file or a folder** that the standard does not own. Only `preset` deletes, and only what `nx new` and `nx g` wrote a moment before: keys of `package.json`, `apps/.gitkeep` and `libs/.gitkeep`.

### What stays in factory

- The brand: the `@factory` scope fallback, the fonts, colors and favicons (#3338).
- The mirror tests `tests/workspace-mirror.test.ts` and `tests/templates-mirror.test.ts`. They prove that factory's own root files equal the output of the generator. factory keeps them, and calls `@zukhruf/nx:init` (#4611).
- `--test-force-exit` for each project: factory sets it in the options of `@zukhruf/nx/test`. The standard adds it only for the tag `test:docker` ([Docker tests](#docker-tests)), so `init` writes the plugin with no options.

### Tests of the generators

The tests use a virtual `Tree` from `createTreeWithEmptyWorkspace` of `@nx/devkit/testing`, as the tests of `@factory/foundation` do (`src/generators/init/generator.test.ts`, `src/generators/preset/generator.test.ts`). They port these tests of `tools/foundation/tests/workspace.test.ts`: the scope in `importOrder`, the full baseline, a second run that changes nothing, `targetDefaults` that are already there, and a `.prettierrc` that is already there. They drop the test of an ESLint config with a multi-line import, because `init` does not change an existing config. New tests:

- `preset` on the files of `nx new`: the result has no `packageManager`, no `apps/.gitkeep` and no `libs/.gitkeep`, `@zukhruf/nx` is in `devDependencies`, and the root `nx` and each `@nx/*` equal `nxVersion` (#4532).
- `preset` with `packageManager: 'pnpm'` stops with an error.
- `init` on a root package name with no scope stops with an error.
- `init` sets a newer `nx` and `@nx/*` down to `nxVersion`, and keeps the version of another root tool.
- Each hook that `init` creates has the mode `755`.
- The backend-neutral output: no React, Vite, Vitest or Tailwind package in `package.json`, and no app wiring in `nx.json`.

### Test the preset

A commit to main is a release (root [ADR 0007](../../docs/adr/0007-release-does-not-wait-for-ci.md)), so a test of the generators runs on a published version. Two targets do it, and `.github/workflows/nightly.yml` runs them each day and on `workflow_dispatch`, and no release waits for them ([ADR 0020](./docs/adr/0020-two-nightly-checks-run-the-generated-workspace-and-compare-an-upgraded-one-with-a-fresh-one.md)):

```sh
npx nx run nx:e2e:smoke                         # latest
npx nx run nx:e2e:smoke --args="--version=0.8.57"
npx nx run nx:e2e:upgrade
```

- `e2e:smoke` makes a workspace with the preset, `node-app`, `react-app`, `pair`, `prisma`, `auth` and `ui-package`, commits it through its hooks, removes what Git ignores except `node_modules`, and runs `nx run-many -t lint typecheck build test --skip-nx-cache`. The tests of the db package need Docker. Give the version in `--args`: Nx reads a `--version` of its own command line.
- `e2e:upgrade` makes the same workspace with the newest release older than a day, moves it to `latest` with `nx migrate` and its migrations, and compares it with a workspace made with `latest`: `targetDefaults`, `namedInputs` and `plugins` of `nx.json`, the `nx` key and `project.json` of each project, and the edges of the task graph. It prints each difference with its two values.

### Who uses the generators

| Consumer | How                                                   | Record |
| -------- | ----------------------------------------------------- | ------ |
| meddit   | `preset`, `node-app`, `react-app`, `pair`             | #4606  |
| meddit   | `prisma`                                              | #4607  |
| meddit   | `dokploy`                                             | #4608  |
| factory  | `init`, `node-app`, `react-app`, `pair`, `ui-package` | #4611  |

The decisions are in [ADR 0009](./docs/adr/0009-a-preset-and-an-init-generator-start-a-repo-from-nothing.md). The backlog item of the generators is #3337.

## app generators

Four generators add the projects of the standard: a backend, a web app, the pair of the two, and a UI package. factory wrote them in its private package `@factory/foundation`; whatisgoingon, text2sql and deepagents hold copies. meddit is the third repo of the same kinds, so they move here (#3338). Each runs [`init`](#add-the-standard-to-an-nx-workspace) first.

### Add a backend, a web app and their pair

```sh
npx nx g @zukhruf/nx:node-app apps/backend
npx nx g @zukhruf/nx:react-app apps/web
npx nx g @zukhruf/nx:pair --api apps/backend --web apps/web
npm install
npx nx sync
```

Then `npx nx run-many -t typecheck lint test build` passes, and `npx nx run @acme/backend:docker:build` builds the image of the backend with the web build in it. The image reports its commit:

```sh
npx nx run @acme/backend:docker:run
curl -s http://localhost:3000/api/healthz   # {"status":"ok","sha":"<git rev-parse HEAD>"}
```

### Add a UI package

```sh
npx nx g @zukhruf/nx:ui-package packages/ui --importPath @acme/ui
```

### Signature of the app generators

```ts
// @zukhruf/nx:node-app
interface NodeAppOptions {
  directory: string; // the project root, for example apps/backend
  port?: number; // 3000: PORT in .env.example, portless --app-port, EXPOSE
}

// @zukhruf/nx:react-app
interface ReactAppOptions {
  directory: string; // the project root, for example apps/web
}

// @zukhruf/nx:pair
interface PairOptions {
  api: string; // the project root of a node-app
  web: string; // the project root of a react-app
}

// @zukhruf/nx:ui-package
interface UiPackageOptions {
  directory: string; // under packages/, for example packages/ui
  importPath: string; // a scoped package name, for example @acme/ui
}
```

Each schema sets `additionalProperties: false`. The project name is the package name: `@<scope>/<last segment of directory>`, for example `@acme/backend`.

### What each app generator writes

| Generator    | Files of the project                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Root and nx.json                                                                                                                                                                                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node-app`   | `src/server.ts` (terminus, the `@nx-target-name: serve` header), `app.ts` (Hono on `/api`), `env.ts` (zod: `HOST` required, `BUILD_SHA`, `LOG_DIR`, `LOG_PRETTY`, no `NODE_ENV`), `logging.ts` (evlog: a file drain when `LOG_DIR` is set, pretty output when `LOG_PRETTY` is `true`), `startup.ts`, `routes/healthz.route.ts`, `app.test.ts`; `.env.example` (always: `NODE_ENV=production`, `HOST=127.0.0.1`, `ALLOWED_ORIGINS=`, `LOG_DIR=.evlog/logs/<app>`, `LOG_PRETTY=true`) and `.env` (when missing); `Dockerfile` (`HOST=0.0.0.0`); `sdk-it.config.ts` and the client stub in `.sdk-it/` (`implicitDependencies` on the backend, `sdk` after `^build-deps`, ADR 0021); the `build-deps` target of the backend; the tsconfigs; `eslint.config.mjs` with `hono`, Modern Node and the env settings | `@nx/node`, `@nx/esbuild`, `esbuild`, `@sdk-it/cli`; `.dockerignore` when missing; the client in `workspaces`; the `.sdk-it` lines of `.gitignore` and `.prettierignore`; the `@nx/esbuild:esbuild` default with the rule of `init` (ADR 0019); the sdk-it exclusion of `production`; `generators["@nx/node"]`            |
| `react-app`  | `index.html`, `src/main.tsx` (React Router 8 in data mode), `src/app/app.tsx` and its test, `src/styles.css` (Tailwind with the sync markers), `vite.config.ts` (the React Compiler, Tailwind, brotli and gzip, the portless and `/api` dev proxy, dev-server `allowedHosts` for `.localhost` and `.trycloudflare.com` (ADR 0010 decision 11), the `test` block), `tsconfig.app.json` writing to `out-tsc`, `tsconfig.spec.json`, `eslint.config.mjs` with `@zukhruf/eslint/react`, `react-router` and `tailwind`                                                                                                                                                                                                                                                                                         | `@nx/react`, `@nx/vite`, `@nx/vitest` with `testMode: "run"`, Vite, Vitest, Testing Library, happy-dom, Tailwind, the 4 React lint plugins; `prettier-plugin-tailwindcss` in `.prettierrc`; the Tailwind sync generator in `sync` and in `build`, `dev`, `serve`; `generators["@nx/react"]`; the `test` default as it was |
| `pair`       | in the web: `src/api.ts` and the client, `zod` and `fast-content-type-parse` in its manifest; in the api: `src/routes/ui.route.ts`, its mount in `app.ts` when `UI_ROOT` is set (the process exits at startup when `<UI_ROOT>/index.html` is missing), `UI_ROOT` (optional) in `env.ts`, and the Dockerfile again with the web build and `UI_ROOT=/app/<web>/dist`                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                                                                                                                                                                                                                                                                                         |
| `ui-package` | `package.json` with the `development` export of `src/index.ts`, `src/package-name.tsx` (a `PackageName` component), `vite.config.ts` (a library with `vite-plugin-dts`), the tsconfigs, `eslint.config.mjs` with `@zukhruf/eslint/react` and `tailwind`, `tests/public-api.test.mjs`, `tests/package-name.test.mjs` (renders `PackageName` in happy-dom under `node:test`; `@happy-dom/global-registrator` and `react-dom` in its `devDependencies`)                                                                                                                                                                                                                                                                                                                                                      | the React root packages; `fsevents: false` in `allowScripts`                                                                                                                                                                                                                                                              |

The targets of a project are in the `nx` key of its `package.json`: the generators pass `useProjectJson: false` to Nx, and Nx 24 always registers its inference plugins, so the targets come from those plugins. `format`, `lint`, `test` (node) and `typecheck` come from the inference plugins; `node-app` writes `build` (one ESM esbuild bundle, each npm package external, with a `require` banner), `serve` (with `NODE_ENV=production`), `portless` (`<app>.<scope>`), `docker:build` and `docker:run`, and keeps `prune-lockfile` of `@nx/node`. `react-app` writes `portless`, `dev` and `serve` with `NODE_ENV=development` (Vite turns React Fast Refresh off under production), and the `test` target of the project (`NODE_ENV=test`, because production React has no `act()`; its `dependsOn` is the rule of `init`, ADR 0019).

Both app generators add `PORTLESS_UNPRIVILEGED=1` and `PORTLESS_HTTPS=1` to `targetDefaults.portless.options.env` in `nx.json`, and keep any key that is already there. One portless proxy serves every app on the machine, and the first target to start it sets its mode. Unprivileged mode needs no sudo, so an agent with no TTY can start the proxy; without it, the start exits 1 with `Proxy is not running and no TTY is available for sudo`. HTTPS is set explicitly because portless 0.18 keeps the unprivileged mode when the proxy stops but resets its TLS, and an unprivileged proxy restarts on plain HTTP. That breaks the generated wiring, which expects `https://<name>.localhost`: the HMR client in `vite.config.ts` dials `wss` on port 443, and a plain-HTTP proxy does not serve 443. The generators set no `PORTLESS_TLD`: `localhost` is the default, and a set TLD replaces the TLDs that another repo's proxy saved. A repo that needs a real dev domain sets the TLD itself. A target with its own `options.env` drops this default unless that env starts with `"...": true`.

### The commit of an image

`docker:build` runs `docker build --file <root>/Dockerfile --build-arg BUILD_SHA=$(git rev-parse HEAD) --tag <scope>-<app> .` from the workspace root. The runtime stage has `ARG BUILD_SHA` and `ENV ... BUILD_SHA=$BUILD_SHA`, `env.ts` accepts a non-empty string or nothing, and `/api/healthz` returns `{ "status": "ok", "sha": <BUILD_SHA or null> }`. So a deploy can tell the new container from the old one. An image built without the build arg gets an empty `BUILD_SHA`, and `env.ts` stops it at start. terminus answers `/healthz` (no `/api`) for the `HEALTHCHECK`.

### Versions that the app generators write

- The packages of the apps have exact versions in `appPackageVersions` of `src/generators/versions.ts`, the latest on 2026-11-18: Hono 4.13, `@hono/node-server` 2.1, evlog 2.35, zod 4.6, sdk-it 0.46.11, esbuild 0.28, React 19.3, React Router 8.5, Vite 8.3, Vitest 5.1, Tailwind 4.3, `@vitejs/plugin-react` 6.3, `@rolldown/plugin-babel` 0.3, `vite-plugin-dts` 5.1.
- An app generator reads the root package names before the generator of Nx runs. After it, a package of the app that was not there gets its pin, also over the version that Nx wrote; a version that was there stays. Each root `nx` and `@nx/*` gets `nxVersion`.
- Residue goes when the run added it: the swc toolchain, `eslint-plugin-import`, `eslint-plugin-jsx-a11y` and `eslint-plugin-react` (they cap ESLint below 10), the root `react` and `react-dom` (each project declares its own), `@vitest/ui`, and for `ui-package` `@babel/core`, `@babel/preset-react`, `ajv` and the root `vite-plugin-dts`.
- `allowScripts`: `esbuild: true`, `@parcel/watcher: false` and `fsevents: false` from `node-app`; `fsevents: false` from `ui-package`, because its `vite` brings it. A decision that is there stays.
- `overrides`: `@juristr/nx-tailwind-sync` takes the one `@nx/devkit` (#4532); `@sdk-it/cli` and `@sdk-it/hono` take the root `typescript`, because sdk-it peers on `^6.0.3` and the TypeScript 6 alias is 6.0.2.

### Where the Nx plugins come from

`@nx/node`, `@nx/react`, `@nx/vite` and `@nx/vitest` are optional peers. An app generator requires the plugin from `@zukhruf/nx`, and else installs it at `nxVersion` into a temporary folder with `ensurePackage` of `@nx/devkit`, as the generators of Nx do. The plugin's own generator adds it to the root `package.json`. A repo with only a backend installs no React, Vite, Vitest or Tailwind package.

### Errors of the app generators

| Error                                                                  | When                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| `The root package name "acme" has no scope.`                           | The root package is not named `@<scope>/source` (from `init`) |
| `The directory "../x" is not a folder in the workspace.`               | `directory` leaves the workspace or is empty                  |
| `apps/backend has no sdk-it.config.ts, so it is not a node-app. Run …` | `pair --api` names a project that `node-app` did not write    |
| `apps/web has no vite.config.ts, so it is not a react-app. Run …`      | `pair --web` names a project that `react-app` did not write   |
| `A UI package goes under packages/, not "…".`                          | `ui-package` outside `packages/`                              |
| `<root> already belongs to <name>.`                                    | `ui-package` on a folder of another package                   |

### What stays in factory after the move

The brand: the fonts, colors and favicons of `index.html`. The generated `index.html` has none of them; it keeps the theme script (light, dark or system, set before the first paint) and `styles.css` keeps the `dark` variant, because the standard puts them in each web app (ADR 0010). factory switches to these generators in #4611.

### Tests of the app generators

The tests run each generator on a virtual `Tree` with Nx 24.0.6, which zukhruf's root installs (`src/generators/*/generator.test.ts`, helpers in `src/testing/generator-tree.ts`). They port factory's `node-app`, `react-app`, `pair` and `ui-package` tests, and add the build sha, `testMode: "run"`, `test.dependsOn` after `node-app` and `react-app`, a backend-only workspace with no React, Vite, Vitest or Tailwind package, the workspace scope in the portless domain, and no brand in the web files. They drop factory's `modern-node.test.ts` and `root-vite.test.ts`, which write to disk and read zukhruf's installed versions; the smoke test below runs lint and a strict `npm install` instead. What Nx 24.0.6 writes itself is proven by the smoke test. Each app generator's test also lints the package.json and project.json files it writes with the manifest rules of @zukhruf/eslint (`src/testing/lint-manifests.ts`), except the rules that read files beyond the manifest, its workspace root or the project graph: `manifest/dependency-checks`, `manifest/no-root-script`, `manifest/nx-family-pinned`, `zukhruf/no-generate-package-json`, `zukhruf/no-duplicate-nx-key`, `zukhruf/no-missing-asset-input` and `zukhruf/no-missing-dependency-build`.

### Test the app generators

In a workspace from the published preset (`npx create-nx-workspace@latest acme --preset=@zukhruf/nx --pm=npm --nxCloud=skip --aiAgents=none`): run the 3 commands of [Add a backend, a web app and their pair](#add-a-backend-a-web-app-and-their-pair), then `npx nx run-many -t typecheck lint test build`, the first commit (each hook passes), `npx nx run @acme/backend:docker:build`, and a container whose `/api/healthz` reports `git rev-parse HEAD`.

The decisions are in [ADR 0010](./docs/adr/0010-the-app-generators-move-here-and-call-the-generators-of-nx.md). The backlog item of the app generators is #3338.

## prisma generator

`prisma` writes a Postgres db package on Prisma 7 and `@prisma/adapter-pg`, and can connect a node-app to it. text2sql holds 5 copies of the package and factory 1, and meddit is the next one, so the shape moves here (#4604). The Prisma targets come from the [prisma area](#prisma). The generator writes only `up` and `down`, for the local Postgres of `compose.dev.yml` (ADR 0012, decisions 16 and 17).

### Add a db package

```sh
npx nx g @zukhruf/nx:prisma packages/db --backend apps/backend
npm install
npx nx sync
npx nx run @acme/db:generate
```

Then `npx nx run-many -t typecheck lint test build` passes, and the tests of `@acme/db` and `@acme/backend` run against a Postgres of `@zukhruf/testing`. Leave out `--backend` for a package that no backend uses yet. `npx nx run @acme/backend:serve` starts the local Postgres of `compose.dev.yml` first and applies the migrations to it. Give each repo whose stack runs beside another a port of its own with `--port`, for example `--port 5435`.

### Signature of the prisma generator

```ts
// @zukhruf/nx:prisma
interface PrismaOptions {
  directory: string; // the project root, for example packages/db
  backend?: string; // the project root of a node-app, for example apps/backend
  port?: number; // 5432: the host port of the local Postgres in compose.dev.yml
}
```

The schema sets `additionalProperties: false`. The package name is `@<scope>/<last segment of directory>`, for example `@acme/db`.

### What the prisma generator writes

| File                                  | Content                                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.prisma`                       | the `prisma-client` generator with `output = "src/prisma"` and `importFileExtension = "ts"`, and the `postgresql` datasource; the models go in `models/*.prisma`                                                          |
| `prisma.config.ts`                    | `schema: '.'`, `migrations.path: 'migrations'`, `url` from `CONNECTION_STRING` and `shadowDatabaseUrl` from `SHADOW_CONNECTION_STRING`, each read only when set, so `generate` runs with none; no dotenv                  |
| `migrations/migration_lock.toml`      | `provider = "postgresql"`                                                                                                                                                                                                 |
| `models/.gitkeep`                     | the image copies `models/`, so the folder is in Git before the first model                                                                                                                                                |
| `src/index.ts`                        | `createPrisma({ connectionString })` on the Postgres adapter, and each export of the generated client; it reads no environment                                                                                            |
| `src/testing.ts`                      | `applySchema(connectionString)`: runs each `migrations/*/migration.sql` in order with `pg`, with no `_prisma_migrations` record, for a test database that is thrown away                                                  |
| `src/index.test.ts`                   | a query on a database of `@zukhruf/testing/postgres` after `applySchema`; the project has the tag `test:docker`                                                                                                           |
| `package.json`                        | the `.` and `./testing` exports (`development` the source, `import` `dist`); `@prisma/client`, `@prisma/adapter-pg`, `pg` and `tslib` in `dependencies`; `prisma` and `@types/pg` in `devDependencies`                    |
| `tsconfig.lib.json`                   | the build: JavaScript and declarations into `dist`, with `rewriteRelativeImportExtensions`, because the generated client imports `.ts` files                                                                              |
| `tsconfig.json`, `tsconfig.test.json` | the solution file and the tests, as in node-app                                                                                                                                                                           |
| `eslint.config.mjs`                   | ignores `src/prisma`; Modern Node; `allowDefaultProject` for `prisma.config.ts`                                                                                                                                           |
| `.env.example`, `.env`                | `NODE_ENV=production`, `CONNECTION_STRING=postgresql://postgres:postgres@127.0.0.1:<port>/<scope>`, the local Postgres, and `SHADOW_CONNECTION_STRING=`; `.env` only when missing                                         |
| `package.json` `nx.targets`           | `up`: `docker compose --file <root>/compose.dev.yml up --detach --wait database`, then `prisma migrate deploy`, with `CONNECTION_STRING` pinned to the local URL; `down`: `docker compose … down`, which keeps the volume |
| `Dockerfile.migration`                | `npm ci --workspace=<package>` installs the CLI from the lockfile, and `CMD npx prisma migrate deploy` applies the migrations to the `CONNECTION_STRING` of the container                                                 |

At the root: `compose.dev.yml` when missing, with one `database` service (the `postgres:18-alpine` of the deployed stack on `127.0.0.1:<port>`, the database `<scope>`, a named volume at `/var/lib/postgresql`, a `pg_isready` healthcheck); `@zukhruf/nx/prisma` in `plugins`; `migrate:check` in the `dependsOn` of the `typecheck` default, with `...` (the `generate` entries are the rule of `init`, ADR 0019); `<root>/src/prisma` in `.gitignore` and `.prettierignore`; `.dockerignore` when missing; the package root in `workspaces` when no `<parent>/*` glob holds it; `@zukhruf/testing`; and `@prisma/engines: true`, `prisma: false`, `ssh2: false`, `cpu-features: false` in `allowScripts`. A second run keeps the files of the package and adds no line or key twice.

With `--backend`, the node-app gets:

- `CONNECTION_STRING: z.string().min(1)` in `src/env.ts`, and the local URL in `.env.example` and in a `.env` that has no such key.
- `^up` in the `dependsOn` of `serve`: the backend imports the db package, so `serve` and `portless` start on a machine with no database.
- In `src/startup.ts`, the client and one `SELECT 1` before the app serves, so a database that refuses the connection stops the boot. `$connect()` alone opens no connection on a driver adapter.
- `await prisma.$disconnect()` in the terminus `onSignal` of `src/server.ts`.
- `src/database.test.ts`, which imports the package through its exports, and the tag `test:docker`.
- The npm packages of the db package in its `dependencies`, not the package: the bundle inlines the package and leaves them external, so `prune-lockfile` puts them in the image.

### Versions that the prisma generator writes

`prisma`, `@prisma/client` and `@prisma/adapter-pg` have one exact version, 7.10.1, in `appPackageVersions`. The `latest` tag of `prisma` is a release candidate of 8 (8.0.0-rc.34 on 2026-11-18) while the other two are at 7.10.1, so no version comes from `latest`, and a test checks that the three are equal and stable.

### Migrations

Write each migration with `npx nx run @acme/db:migrate:create --name <name>`, the first one too. It writes the diff from the migrations to the schema into `migrations/<time>_<name>/migration.sql` (see [Check the migrations](#check-the-migrations)). Read the SQL, and edit it before `deploy` when it can fail on a table with rows. `migrate:check` runs before `typecheck`, so the `typecheck` of the package fails when the migrations do not build the schema (commit 19a4bd37). Apply a migration with `nx run @acme/db:deploy`, or with the image. `migrate dev` needs a TTY, so an agent does not run it, and nothing runs `migrate reset` on a shared database.

### Errors of the prisma generator

| Error                                                                  | When                                                      |
| ---------------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/api has no sdk-it.config.ts, so it is not a node-app. Run …`     | `--backend` names a project that `node-app` did not write |
| `packages/db already belongs to @acme/other.`                          | `directory` holds another package                         |
| `apps/backend/src/server.ts has no "import './startup.ts';", so the …` | a backend file lost the line that the wiring changes      |

### Test the prisma generator

In a workspace from the published preset (`npx create-nx-workspace@latest acme --preset=@zukhruf/nx --pm=npm --nxCloud=skip --aiAgents=none`): `node-app apps/backend`, the 4 commands of [Add a db package](#add-a-db-package), and `npx nx run-many -t typecheck lint test build`. Then add a model and a first migration, build `Dockerfile.migration`, and run its container against a new `postgres:18-alpine`: `prisma migrate deploy` applies the migration. On 2026-11-18 each step passed, and the backend image served `/api/healthz` with one database session and stopped at start with a wrong password.

The decisions are in [ADR 0012](./docs/adr/0012-the-prisma-generator-writes-a-postgres-db-package-and-wires-a-backend.md). The backlog item is #4604.

## auth generator

`auth` adds better-auth 1.7.26 to a node-app and to the db package that the prisma generator wired into it. meddit needs sign-in, and text2sql, thing and blackboard each set better-auth up by hand (#4719).

### Add sign-in to a backend

```sh
npx nx g @zukhruf/nx:auth --backend apps/backend --db packages/db
```

After the install, the generator runs `nx run @acme/backend:auth:generate`, which writes the models of better-auth into `packages/db/models/auth.prisma`. Then write the first migration (see [Migrations](#migrations)) and run `npx nx run @acme/backend:auth:check`.

### Add sign-in to a paired web app

```sh
npx nx g @zukhruf/nx:auth --backend apps/backend --db packages/db --web apps/web
```

Pair the web with the backend first. `apps/web/src/auth-client.ts` then exports `authClient`, which calls `/api/auth` on the page origin: the Vite proxy in development, the backend in production. The backend trusts the two origins that the browser sends in development: `http://localhost:5173` (`nx run @acme/web:dev`) and `https://web.acme.localhost` (`nx run @acme/web:portless`). If your portless proxy uses another TLD or a prefix, add that origin to `ALLOWED_ORIGINS` in `apps/backend/.env`; better-auth answers any other origin with 403 `INVALID_ORIGIN`.

In every setup, better-auth builds its links (email verification, password reset) on the host of the page that asked for them when that host is in `ALLOWED_ORIGINS`, so a link opened from the Vite dev server, from portless or from the deployed app signs in that same page. A request from any other host gets `BETTER_AUTH_URL`. better-auth refuses an empty `allowedHosts`, so `ALLOWED_ORIGINS` names at least one origin; the dokploy generator sets the public origin.

### Require a session

The generator protects no route; your route modules and router choose. On the backend, list `signedIn` from `src/session.ts`. A request without a session gets 401 (`UnauthenticatedError` of [`@zukhruf/authentication`](../authentication/README.md)), and the route reads the session on `c.var.session`:

```ts
// apps/backend/src/routes/me.route.ts, added to the route list of app.ts
import type { Hono } from 'hono';

import { signedIn } from '../session.ts';

export default function (app: Hono): void {
  app.get('/me', signedIn, (c) => c.json(c.var.session.user));
}
```

`signedIn` loads `startup.ts` on the first request, so `app.test.ts` still runs without a database. In the web, give each page behind sign-in the loader from `src/session.ts`, with the path of your sign-in page:

```ts
// apps/web/src/main.tsx
import { signedInLoader } from './session.ts';

const router = createBrowserRouter([
  {
    path: '/cases',
    loader: signedInLoader({ signIn: '/sign-in' }),
    Component: Cases,
  },
]);
```

A visitor without a session lands on `/sign-in?redirectTo=%2Fcases`. After you add better-auth's two-factor plugin, pass `{ twoFactor: true }` to `requireSession` in the backend's `src/session.ts`, and `twoFactorSetup` to `signedInLoader`; both are type errors before the plugin is there.

### Signature of the auth generator

```ts
// @zukhruf/nx:auth
interface AuthOptions {
  backend: string; // the project root of a node-app, for example apps/backend
  db: string; // the project root of a db package, for example packages/db
  web?: string; // the project root of a react-app, for example apps/web
}
```

### What the auth generator writes

| File                                        | Content                                                                                                                                                                                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<backend>/src/auth.ts`                     | `createAuth({ prisma, secret, baseURL, trustedOrigins })`: better-auth on `prismaAdapter` with `emailAndPassword`; `baseURL` is `{ fallback, allowedHosts }`; it reads no environment; only when missing                                                 |
| `<backend>/src/session.ts`                  | `export const signedIn = requireSession(sessions)` from `@zukhruf/authentication/hono`; `sessions` loads `startup.ts` on the first request and has the type of the app's session; only when missing                                                      |
| `<backend>/src/auth.cli.ts`                 | `export const auth` for the better-auth CLI, on `createPrisma` with no connection and placeholder secret and URL; it imports no `env.ts` and no `startup.ts`; only when missing                                                                          |
| `<backend>/src/routes/auth.route.ts`        | `GET` and `POST` `/api/auth/*` to `auth.handler`; the handler loads `startup.ts` on the first request, so `app.test.ts` needs no database; only when missing                                                                                             |
| `<backend>/src/app.ts`                      | the mount of the auth route, before the UI mount of pair and before `notFound`                                                                                                                                                                           |
| `<backend>/src/startup.ts`                  | `export const auth = createAuth(...)` on the app's client, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and `ALLOWED_ORIGINS`; in every setup, `baseURL` is the host of an allowed origin, else `BETTER_AUTH_URL`                                             |
| `<backend>/src/env.ts`                      | `BETTER_AUTH_SECRET: z.string().min(32)` and `BETTER_AUTH_URL: z.url()`                                                                                                                                                                                  |
| `<backend>/.env.example`, `.env`            | `BETTER_AUTH_SECRET=` and `BETTER_AUTH_URL=http://localhost:<PORT>`; `.env` gets a random 43-character secret; a key that is there keeps its value                                                                                                       |
| `<backend>/package.json`                    | `better-auth` and `@zukhruf/authentication` in `dependencies`; the `auth:generate` and `auth:check` targets                                                                                                                                              |
| `<web>/src/auth-client.ts`                  | with `--web`: `export const authClient = createAuthClient()` from `better-auth/react`, with no `baseURL`; only when missing                                                                                                                              |
| `<web>/src/session.ts`                      | with `--web`: `signedInLoader(options)`, a loader that calls `requireSession(authClient, request, options)` of `@zukhruf/authentication/react-router`; only when missing                                                                                 |
| `<web>/package.json`                        | with `--web`: `better-auth` and `@zukhruf/authentication` in `dependencies`; a `react-router` below 8.5.2 becomes 8.5.2, the peer range of `@zukhruf/authentication`                                                                                     |
| `<backend>/.env.example`, `.env`            | with `--web`: `http://localhost:5173` and `https://<portless name>.localhost` added to `ALLOWED_ORIGINS`, after the origins that are there                                                                                                               |
| `<db>/models/auth.prisma`                   | a one-line placeholder, which the CLI fills; without it the CLI writes a second generator and datasource, and `prisma generate` fails with P1012; only when missing                                                                                      |
| `infra/src/environments/production/main.tf` | when the dokploy generator wrote the infra: `BETTER_AUTH_SECRET = random_password.better_auth.result` and `BETTER_AUTH_URL = "https://${local.host}"` above the marker of the `env` map of `module "stack"`; only when `BETTER_AUTH_SECRET` is not there |
| `infra/src/environments/production/auth.tf` | when the dokploy generator wrote the infra: `random_password.better_auth`, 64 characters, no special characters, with `prevent_destroy`, because a new secret signs every user out; only when missing                                                    |

At the root: the CLI `auth` in `devDependencies`. The generator writes no migration. A second run adds nothing twice. A repo without `module "stack"` in `infra/src/environments/production/main.tf` gets no file in `infra/`.

### What the auth targets run

Both run in the backend root with `NODE_OPTIONS=--conditions=development`, so jiti loads the source of the db package, and with `NODE_ENV=production`, as every target: `auth.cli.ts` passes a throwaway secret of 32 or more characters, so better-auth never meets its default secret, which it refuses under production. Both depend on `^generate`, because that source imports the generated client.

- `auth:generate`: `npx auth generate --adapter prisma --config src/auth.cli.ts --output <db>/models/auth.prisma --yes`, then `nx run <db>:generate`. Run it after you add a plugin to `createAuth`.
- `auth:check`: `npx auth check schema --config src/auth.cli.ts`. It only reads. It exits 1 when the generated client misses a table or column of the plugins, and 2 when it cannot load the config.

### Versions that the auth generator writes

`better-auth` and `auth` have one exact version, 1.7.26, in `appPackageVersions`, and a test checks that they are equal. `@zukhruf/authentication` gets the version of this package, as every zukhruf package has the same version.

### Errors of the auth generator

| Error                                                                                                                                                                                                                                                                                   | When                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/api has no sdk-it.config.ts, so it is not a node-app. Run …`                                                                                                                                                                                                                      | `--backend` names a project that `node-app` did not write                                         |
| `packages/db has no prisma.config.ts and createPrisma, so it is not a db package. Run …`                                                                                                                                                                                                | `--db` names a project that `prisma` did not write                                                |
| `apps/backend/src/startup.ts does not create the client of @acme/db. Run @zukhruf/nx:prisma …`                                                                                                                                                                                          | the prisma generator did not wire the db into this backend                                        |
| `apps/web has no vite.config.ts, so it is not a react-app. Run …`                                                                                                                                                                                                                       | `--web` names a project that `react-app` did not write                                            |
| `infra/src/environments/production/main.tf calls module "stack" but its env has no "# Generators add env keys above this line.", so the generator cannot add BETTER_AUTH_SECRET = … and BETTER_AUTH_URL = …. Add the two lines to env, or put the marker back as the last line of env.` | the repo removed the marker from the `env` map of the module call, and the two keys are not there |

### Test the auth generator

After the steps of [Test the prisma generator](#test-the-prisma-generator) up to `run-many`: run `auth --backend apps/backend --db packages/db`, then check that `auth:check` exits 0, that `run-many -t typecheck lint build test` passes, and that a second run changes no file. On 2026-11-19 each step passed. The production bundle on a `postgres:18-alpine`, with the schema from `prisma migrate diff`, answered `POST /api/auth/sign-up/email` with 200.

For `--web`, also run `react-app apps/web` and `pair` before prisma, and `auth` with `--web apps/web`. Start `serve` of the backend and `dev` of the web, then send `POST http://localhost:5173/api/auth/sign-up/email` with `Origin: http://localhost:5173`: it answers 200, and with another origin 403. Repeat on `https://web.acme.localhost` under the `portless` target. On 2026-11-19 each step passed, and `authClient.signUp.email` in Chromium answered 200.

For the guards, add a route that lists `signedIn`: `GET` it without a cookie (401), then after sign-in (200). On 2026-11-19 both answers were right, through the Vite dev server, and a verification link opened through the Vite dev server and through portless signed in the page on that origin.

The decisions are in [ADR 0014](./docs/adr/0014-the-auth-generator-adds-better-auth-to-a-backend-and-its-db-package.md). The backlog item is #4719.

## dokploy generator

`dokploy` writes the GitOps delivery of a node-app on Dokploy: an OpenTofu project in `infra/` whose `main.tf` calls zukhruf's [`dokploy-stack` module](./opentofu/dokploy-stack/README.md) to store the compose in Dokploy, and the workflows that build the images, apply the stack and roll it out. text2sql (v2, authx) and whatisgoingon hold copies, and meddit is the third repo, so the shape moves here (#4603). The workflows call zukhruf's kit at `@main`: the reusable `tofu-apply.yml`, and the `dokploy-deploy` and `wait-for-health` actions. The module call follows `main` too.

The generator writes each file only when it is missing, and never deletes one: after the first run, every file is the repo's (ADR 0015). A rerun adds the lines of `.prettierignore`, `.nxignore` and the `nx.json` plugin entry that are missing, and changes nothing else.

```hcl
module "stack" {
  source = "git::https://github.com/JanuaryLabs/zukhruf.git//packages/nx/opentofu/dokploy-stack?ref=main"

  name         = "acme"
  description  = "acme at acme.<server ipv4>.sslip.io - managed by OpenTofu"
  app          = "backend"
  compose_file = file("${path.module}/../../../compose.dokploy.yml")
  database     = { role = "acme" }
  registry     = { username = "octocat", password = var.ghcr_pull_token }

  env = {
    PUBLIC_HOST     = local.host
    ALLOWED_ORIGINS = "https://${local.host}"
    # Generators add env keys above this line.
  }
}
```

A key that the app needs goes into `env`; the app reads it through `env_file: .env`. A secret is a sensitive variable in `variables.tf`, fed by `TF_ENV` in `deploy.yml` and by `infra/.env` for a local preview.

### Deliver a backend

```sh
npx nx g @zukhruf/nx:dokploy --api apps/backend --owner <github-owner>
npx nx run @acme/infra:typecheck
```

With Postgres, a Prisma package, a private GHCR and a DNS name:

```sh
npx nx g @zukhruf/nx:dokploy --api apps/backend --owner Phi-Science \
  --database packages/db --registryUser <github-user> --host app.example.com
```

Then add the repository secrets `TF_ENCRYPTION_PASSPHRASE`, `DOKPLOY_API_KEY` and `HCLOUD_TOKEN`, and `GHCR_PULL_TOKEN` with `--registryUser`. A push to `main` runs CI, and a green CI run deploys.

### Signature of the dokploy generator

```ts
// @zukhruf/nx:dokploy
interface DokployOptions {
  api: string; // the project root of a node-app
  owner: string; // the GitHub owner; the images are ghcr.io/<owner, lowercase>/<name>-<app>
  name?: string; // the Dokploy project and the image prefix; the workspace scope
  dokployHost?: string; // https://dokploy.limerence.sh/api
  server?: string; // the Hetzner server that runs Dokploy: limerence-dokploy
  host?: string; // a DNS name in a Hetzner zone; without it, <name>.<server ipv4>.sslip.io
  zone?: string; // the Hetzner zone of host: host without its first label
  database?: string; // the project root of a Prisma package: adds Postgres and the migrate service
  registryUser?: string; // the GitHub user of GHCR_PULL_TOKEN: adds a Dokploy registry for private images
}
```

### What the dokploy generator writes

| File                                     | What it holds                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/project.json`                     | `@<scope>/infra`; `@zukhruf/nx/opentofu` gives its targets, and the generator lists that plugin after `@zukhruf/nx/format` in `nx.json`                                                                                                                                                                   |
| `infra/compose.dokploy.yml`              | the app image with `env_file: .env` on `dokploy-network` with the Traefik labels (`web` redirects, `websecure` with Let's Encrypt); with `database`, `postgres:18-alpine` and the one-shot `migrate`, which the app waits for                                                                             |
| `infra/.env.example`, `infra/.gitignore` | `NODE_ENV=production`, the secrets of a local run, `TF_VAR_dokploy_api_key=${DOKPLOY_API_KEY}` (and `TF_VAR_ghcr_pull_token`); the plaintext backups, `.terraform/` and `tfplan`                                                                                                                          |
| `src/environments/production/*.tf`       | `versions`, `backend` (local, the encrypted state committed), `encryption` (pbkdf2 and aes_gcm, enforced), `providers`, `dns`, `main` (the module call; `registry` is its input), `outputs` (`dokploy_api`, `compose_id`, `host`), `variables`                                                            |
| `.terraform.lock.hcl`                    | the providers for `linux_amd64` and `darwin_arm64`, `hashicorp/random` always, because the module requires it, so `typecheck` (`-lockfile=readonly`) passes on CI and a Mac                                                                                                                               |
| `.prettierignore`, `.nxignore`           | lines added when missing: `.terraform`, `tfplan` and the state for Prettier; the state for Nx, so the state commit of an apply makes no project affected                                                                                                                                                  |
| `.github/workflows/deploy.yml`           | `env: NODE_ENV: production` at workflow level; gate (`tested-commit`, `affected-range` since the last deploy, `affected-projects`), image (`ghcr-image`, a matrix: the app and `migrate`), promote to `:latest` (`ghcr-promote`), infra (`tofu-apply.yml`), release (`dokploy-deploy`, `wait-for-health`) |
| `.github/workflows/ci.yml`               | `env: NODE_ENV: production` at workflow level; setup-workspace, OpenTofu in the background, `affected-range`, then `nx affected -t lint typecheck test build` beside `sync:check`, `prettier --check` and zizmor                                                                                          |
| `.github/zizmor.yml`                     | tags and `@main` allowed (`ref-pin`), and the `workflow_run` of `deploy.yml`                                                                                                                                                                                                                              |

The compose reads `PUBLIC_HOST` in its labels, Postgres reads `POSTGRES_PASSWORD` and `migrate` reads `CONNECTION_STRING`, from the env that the module stores with it; a plan refuses a `${NAME}` that the env does not have. Postgres 18 keeps its data under `/var/lib/postgresql/18/docker`, so the volume is mounted at `/var/lib/postgresql`. Each variable refuses an empty value, because CI renders an unset secret as `""`. The stack has no `terraform_data` deployment: the release job deploys after a new image, after an apply that changed the stack, and while the infra project is affected since the last successful deploy, and it checks the build sha only after a new image. `.prettierignore` gets `.terraform`, `tfplan` and the state.

### Errors of the dokploy generator

| Error                                                                           | When                                                     |
| ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `apps/backend has no Dockerfile, so it is not a node-app. Run …`                | `--api` names a project that `node-app` did not write    |
| `packages/db has no Dockerfile.migration, so it is not a Prisma package. Run …` | `--database` names a project that `prisma` did not write |
| `The zone "example.com" needs a host in it.`                                    | `--zone` without `--host`                                |
| `The host "app.example.org" is not a name in the zone "example.com".`           | `--host` outside `--zone`                                |
| `The name "My App" is not a lowercase name that starts with a letter.`          | `--name`, or the scope, is not a lowercase name          |

### Test the dokploy generator

After the steps of [Test the app generators](#test-the-app-generators), run `prisma` and then `dokploy` with `--database`, `--registryUser` and no `--host`, then `npm install`, `npx nx sync`, `npx nx run @acme/infra:typecheck`, `actionlint .github/workflows/*.yml`, `npx nx run-many -t typecheck lint`, `npx prettier --check .`, and `docker compose -f infra/compose.dokploy.yml config` (with an `infra/.env`, which the app's `env_file` names). actionlint 1.7.12 does not know the `parallel:` step of `ci.yml`, which GitHub runs. On 2026-11-18 each passed, also after a run with `--host` and no `--database` or `--registryUser`; after that, two runs with the first options passed again, and the second of them changed no file.

The decisions are in [ADR 0011](./docs/adr/0011-the-dokploy-generator-writes-the-gitops-delivery-of-a-node-app.md) and [ADR 0015](./docs/adr/0015-an-opentofu-module-of-zukhruf-holds-the-dokploy-delivery-and-the-dokploy-generator-writes-infra-once.md). The backlog items of the dokploy generator are #4603 and #4733.

## Documentation

**Decisions**

- [ADR 0001](./docs/adr/0001-inferred-targets-not-copied-defaults.md): an inference plugin gives each project its format targets.
- [ADR 0002](./docs/adr/0002-a-check-never-writes.md): a check target never writes.
- [ADR 0003](./docs/adr/0003-which-roots-get-targets.md): the plugin gives targets to the projects of Nx, by the matcher of Nx.
- [ADR 0004](./docs/adr/0004-node-test-target-from-test-files.md): the plugin gives the test target to each project root that owns node:test files (superseded in part by ADR 0006 for the project roots, and for the default timeout by the owner, #4205).
- [ADR 0005](./docs/adr/0005-docker-tests-get-the-global-setup.md): a project with the tag test:docker gets the global setup of @zukhruf/testing.
- [ADR 0006](./docs/adr/0006-lint-inputs-from-the-eslint-package.md): the plugin adds the packages of @zukhruf/eslint to the inputs of lint.
- [ADR 0007](./docs/adr/0007-opentofu-targets-from-environments-with-no-apply.md): an inference plugin gives each OpenTofu project its targets, and no apply target.
- [ADR 0008](./docs/adr/0008-prisma-targets-from-prisma-config-with-outputs-from-the-schema.md): an inference plugin gives each Prisma project its targets, with the outputs that the schema names (superseded in part by ADR 0019).
- [ADR 0009](./docs/adr/0009-a-preset-and-an-init-generator-start-a-repo-from-nothing.md): a preset and an init generator start a repo from nothing.
- [ADR 0010](./docs/adr/0010-the-app-generators-move-here-and-call-the-generators-of-nx.md): the app generators move here and call the generators of Nx (superseded in part by ADR 0019).
- [ADR 0011](./docs/adr/0011-the-dokploy-generator-writes-the-gitops-delivery-of-a-node-app.md): the dokploy generator writes the GitOps delivery of a node-app (decision 17 superseded by ADR 0015 for the files of `infra/`).
- [ADR 0012](./docs/adr/0012-the-prisma-generator-writes-a-postgres-db-package-and-wires-a-backend.md): the prisma generator writes a Postgres db package and wires a backend (superseded in part by ADR 0019).
- [ADR 0013](./docs/adr/0013-a-target-names-the-tools-it-needs-and-a-hook-checks-them-before-ci-runs-tasks.md): a target names the tools it needs, and a hook checks them before CI runs tasks (rejected by the owner, #4654).
- [ADR 0014](./docs/adr/0014-the-auth-generator-adds-better-auth-to-a-backend-and-its-db-package.md): the auth generator adds better-auth to a backend and its db package (proposed; superseded in part by ADR 0016).
- [ADR 0015](./docs/adr/0015-an-opentofu-module-of-zukhruf-holds-the-dokploy-delivery-and-the-dokploy-generator-writes-infra-once.md): an OpenTofu module of zukhruf holds the Dokploy delivery, and the dokploy generator writes infra once.
- [ADR 0016](./docs/adr/0016-the-generated-code-reads-explicit-settings-and-never-nodeenv.md): the generated code reads explicit settings, and never NODE_ENV.
- [ADR 0017](./docs/adr/0017-nx-migrations-bring-a-change-of-generated-output-to-the-repos-that-ran-the-generator-before.md): Nx migrations bring a change of generated output to the repos that ran the generator before.
- [ADR 0018](./docs/adr/0018-migrate-check-diffs-the-migrations-on-a-shadow-database-that-it-makes.md): migrate:check diffs the migrations on a shadow database that it makes.
- [ADR 0019](./docs/adr/0019-a-task-that-reads-generated-code-runs-its-generator-first-and-hashes-its-output.md): a task that reads generated code runs its generator first and hashes its output.
- [ADR 0020](./docs/adr/0020-two-nightly-checks-run-the-generated-workspace-and-compare-an-upgraded-one-with-a-fresh-one.md): two nightly checks run the generated workspace and compare an upgraded one with a fresh one.
- [ADR 0021](./docs/adr/0021-the-sdk-it-client-depends-on-its-backend-and-runs-after-the-builds-of-the-backends-dependencies.md): the sdk-it client depends on its backend and runs after the builds of the backend's dependencies.

**Copied code**

- [docs/copied-code.md](./docs/copied-code.md): each copy of code in this package, as the Rule of Three asks.
