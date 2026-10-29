# @zukhruf/eslint

ESLint rules and configs that several repos share. Each check is a named rule, such as `zukhruf/no-enum`. A repo's own config cannot silently erase it, and a repo can turn off one check by name.

The words in this document have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## The problem

The same rules were copied from repo to repo, and the copies broke in three ways:

1. **One key, many checks.** The hand-written bans (no enums, no test hooks, …) were entries of one rule, `no-restricted-syntax`. Flat config keeps one options list for each rule. A framework preset set `no-restricted-syntax` again, and every ban was gone.
2. **Globs that depend on the folder.** `nx lint` runs ESLint from the project folder. When a project's config re-exports the root config, a glob such as `apps/**` matches nothing.
3. **Partial options.** A project set `@nx/dependency-checks` with only its own `ignoredFiles`. The rule's defaults filled in the rest, and the shared policy was lost.

This package gives each check its own key, writes every glob as `**/…`, scopes by the linted file's path, and builds options with factories that add a repo's entries to the shared ones.

## Use it

You need ESLint 9.30 or later.

```sh
npm install --save-dev @zukhruf/eslint
```

Its peers are `eslint`, `@eslint/js`, `typescript-eslint`, `typescript`, `eslint-plugin-import-x`, `eslint-plugin-functional` and `jsonc-eslint-parser`. `@zukhruf/eslint/nx` also needs `@nx/eslint-plugin`, and `@zukhruf/eslint/react-native` needs `eslint-plugin-es-x`. npm installs the peers for you. With `legacy-peer-deps=true` in `.npmrc`, npm does not, so add them to your devDependencies.

```js
// eslint.config.mjs
import { defineConfig } from 'eslint/config';

import zukhruf from '@zukhruf/eslint';

export default defineConfig({
  plugins: { zukhruf },
  extends: ['zukhruf/base', 'zukhruf/tests'],
});
```

Put framework presets (for example Nx's `flat/react`) **before** the zukhruf configs. The package's own checks survive any order. But `base` also changes some third-party rules, for example it turns `@typescript-eslint/no-unused-vars` off, and a preset that comes later sets them again.

## Configs

| Config            | Files                                 | Rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`            | all source                            | `@eslint/js` and `typescript-eslint` recommended; `consistent-type-assertions` (never), `no-namespace`, `zukhruf/no-enum`; `import-x/no-duplicates`, `import-x/no-unassigned-import`; `functional/no-let` (module scope); `zukhruf/no-state-managers`, `zukhruf/no-playwright-test`, `zukhruf/no-test-file-import`, `zukhruf/no-collect-loop`; typed lint: `no-floating-promises`, `no-misused-promises`, `only-throw-error`, `switch-exhaustiveness-check` (a `default` counts as exhaustive), `zukhruf/no-promise-field`, `zukhruf/no-phase-flag`; `no-require-imports` is off in `.cjs` and `.cts`, because `require()` is the only import form in a CommonJS file |
| `tests`           | test files, `src/testing`             | `no-test-lifecycle-hooks`, `no-process-env-write`, `no-direct-msw-server`, `no-catch-all-msw-handler`, `no-timer-race`, `no-sleep-poll-loop`, `no-global-test-mock`, `no-raw-temp-directory`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `diagnostics`     | source, not tests                     | `no-fabricated-fallback`, `no-hardcoded-id-shape`, `consistent-event-name`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `env`             | TypeScript, not tests or tool configs | `no-undeclared-process-env`, `no-single-env-read-wrapper`, `no-default-for-path-env`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packaged-app`    | TypeScript, not tests                 | `no-bare-spawn`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `react`           | `.tsx`, `.jsx`                        | `no-as-child`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `react-router`    | source                                | `require-loader-data-type-argument`; outside tests: `no-raw-route-path`, `no-internal-anchor`; TypeScript: `only-throw-error` allows a `Response` and `DataWithResponseInit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `hono`            | TypeScript, not tests                 | `no-untyped-empty-json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `tailwind`        | source                                | `no-h-screen`, `no-arbitrary-z-index`, `no-will-change`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pulumi`          | TypeScript                            | `require-server-replace-guard`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `nx-project-json` | `project.json`                        | `no-missing-asset-input`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

`base` turns on typed lint (`parserOptions.projectService`). Each linted TypeScript file must be in a tsconfig.

`zukhruf/no-promise-field` reads each class field's type, so it also sees a promise behind an alias, in a type argument (`Map<string, Promise<X>>`, `Record<string, Promise<X>>`), in a union or an intersection, in a `PromiseWithResolvers`, or inferred from the initializer. It also looks inside a record that the project declares, such as `Map<string, { key: string; answer: Promise<boolean> }>`, up to four properties deep. It stops at a class, because the rule checks the fields of that class on their own, and at a library's type, because its promises belong to the library. A field that holds a function returning a promise is fine: that is a memoized function. A record of functions that settle a promise, `{ resolve, reject }`, is fine too: the caller keeps the promise. To wait until something has happened, use a state object or a one-shot latch. See [ADR 0006](./docs/adr/0006-no-promise-field-stops-at-the-class-boundary.md).

`zukhruf/no-phase-flag` reads each class field's type too. It reports a field that is a boolean, or that can be `undefined`, when code outside the constructor sets it. A callback that the constructor creates runs later, so its assignment counts as outside. Such a field records a phase, and every reader must know which phase holds. Push the fact as an event, wait on a one-shot latch, keep the phases in state objects, or ask the platform for the fact.

### Options for a repo

Give repo-specific values as rule options. For example:

```js
{
  rules: {
    'zukhruf/no-bare-spawn': ['error', { roots: ['apps/desktop/src'] }],
  },
}
```

`roots` are folders relative to the workspace root. A rule finds the workspace root from the linted file: the nearest folder with `nx.json`, `pnpm-workspace.yaml`, or a `package.json` that declares `workspaces`.

A fact about the repo goes in `settings`, not in rule options. If you set a rule again, you replace its config's `files` and `ignores`. A setting changes no scope. For example, `env` reads the startup env schema from `src/startup.ts` in each project. If the schema is in a different file, give that file:

```js
{
  settings: { env: { startupFile: 'src/env.ts' } },
}
```

A relative `startupFile` is relative to the project of the linted file. `env` does not check test files or tool configs, such as `vite.config.ts`. A tool config runs at build time and has no startup env schema.

Each config registers its plugins for all files. Each rule keeps its own `files` and `ignores`. So you can set a rule in a folder that its config skips, such as `functional/no-let` in `src/testing`. You do not copy the config's globs.

To extend a `base` rule, use its factory. Do not declare the key again with only your entries: that replaces the base options.

```js
import { noFloatingPromises, noLet } from '@zukhruf/eslint';

{
  rules: {
    'functional/no-let': ['error', noLet({ ignoreIdentifierPattern: ['^cached'] })],
    '@typescript-eslint/no-floating-promises': ['error', noFloatingPromises({ allowForKnownSafeCalls: [/* … */] })],
  },
}
```

React Router's loaders and actions throw `redirect()`, `replace()` (a `Response`) or `data()` (a `DataWithResponseInit`). React Router catches the value and renders it. So `react-router` sets `only-throw-error` again with these two types in its allow list. The allow list applies in every TypeScript file of the config, not only in a routes folder, because a loader helper, such as an auth gate, can live in a different folder. Use `react-router` together with `base`, because `base` gives the typed lint that the rule needs. To add more types, use the factory:

```js
import { reactRouterOnlyThrowError } from '@zukhruf/eslint';

'@typescript-eslint/only-throw-error': ['error', reactRouterOnlyThrowError({ allow: [/* … */] })]
```

## Nx: islands and module boundaries

`@zukhruf/eslint/nx` needs `@nx/eslint-plugin`.

```js
import nx from '@nx/eslint-plugin';
import { defineConfig } from 'eslint/config';

import zukhruf from '@zukhruf/eslint';
import island, { islandConstraint, moduleBoundaries } from '@zukhruf/eslint/nx';

export default defineConfig(
  nx.configs['flat/base'],
  {
    plugins: { zukhruf, island },
    extends: ['zukhruf/base', 'zukhruf/tests', 'island/recommended'],
    settings: { island: { libraries: ['packages/**/*.ts'] } },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        moduleBoundaries({
          depConstraints: [islandConstraint(['hono', 'hono/*'])],
        }),
      ],
    },
  },
);
```

An island is an Nx project tagged `layer:island`. Its tags come from its `project.json` or its `package.json` `nx.tags`. `island/recommended` has these rules:

- `island/no-generic-port` and `island/no-explicit-any` in islands.
- `island/no-process-env` and `island/no-console` in islands and in the files that `settings.island.libraries` names.
- `island/dependency-checks` on each island's `package.json`, with `dependencyPolicy()`.

`moduleBoundaries()` and `dependencyPolicy()` add your entries to the shared options:

```js
'island/dependency-checks': ['error', dependencyPolicy({ ignoredDependencies: ['electron'] })]
```

### Every other manifest

`manifest/recommended` checks the `package.json` of every project that is not an island. What a manifest must declare depends on the project's shape:

- A **bundled** project is an application whose build inlines the workspace packages it imports. Their manifests are not there when it is deployed, so its own manifest declares every npm package they pull in. Workspace packages themselves are not demanded.
- Every other project is **unbundled**. It declares what its own code imports.

The rule reads the build target as Nx resolves it: `project.json`, the target defaults in `nx.json`, and the targets that Nx plugins infer. An application bundles unless its build compiles with tsc, is `nx:noop`, or is esbuild with `bundle: false`. tsc emits one file for each source file and keeps each import. The rule counts `@nx/js:tsc` and the `tsc --build` target that the `@nx/js/typescript` plugin infers.

An esbuild app can name workspace packages in `external`. Its build does not inline those packages, so they come from `node_modules` when the app runs. When the app imports one of them, it is unbundled, and its manifest declares them. Its manifest does not declare the workspace packages that its build still inlines. The rule reads the list that Nx gives esbuild: `external` and `esbuildOptions.external`, less the entries in `excludeFromExternal`. A `*` in an entry is esbuild's wildcard, as in `@acme/*`.

A `testing/` folder holds test support, so the rule does not check its imports. A package can also ship a testing subpath to its consumers. So the rule checks a `testing/` folder when the manifest publishes it: an `exports` target or a `files` entry has a `testing` segment, or an `exports` target has a `*`. For a bundled project, the rule applies the same decision to each workspace package that it inlines.

Nx's check follows the imports of all workspace packages, or of none. So when an app inlines some workspace packages and names others in `external`, the rule does not check the npm imports of the inlined packages.

```js
import island, { manifest } from '@zukhruf/eslint/nx';

export default defineConfig({
  plugins: { island, manifest },
  extends: ['island/recommended', 'manifest/recommended'],
  rules: {
    'manifest/dependency-checks': [
      'error',
      {
        ignoredDependencies: ['electron'],
        projects: {
          'apps/website': { ignoredDependencies: ['@radix-ui/react-slot'] },
        },
      },
    ],
  },
});
```

The rule decides each manifest's options itself, so your options add to the shared policy and never replace it. `projects` keys are folders relative to the workspace root. Like Nx's own rule, it needs the project graph that `nx` caches; without it, the rule checks nothing. It needs `@nx/devkit`, which `@nx/eslint-plugin` installs.

## React Native: Hermes

`@zukhruf/eslint/react-native` needs `eslint-plugin-es-x`. es-x 10 needs ESLint 10.6 or later; on ESLint 9, install `eslint-plugin-es-x@9`. `hermes/recommended` checks the code that ships in the app, and leaves tests, config files and scripts alone, because those run in Node:

- the `Intl` APIs Hermes does not have: es-x's `no-intl-displaynames`, `no-intl-durationformat`, `no-intl-listformat`, `no-intl-locale`, `no-intl-pluralrules`, `no-intl-relativetimeformat` and `no-intl-segmenter`;
- Node's built-in modules: `import-x/no-nodejs-modules`;
- `hermes/no-missing-console`: `console.clear`, `dir`, `dirxml`, `profile`, `profileEnd` and `timeLog`, which React Native release builds do not have, and `console[name]` with a computed name.

```js
import hermes from '@zukhruf/eslint/react-native';

export default defineConfig({
  plugins: { zukhruf, hermes },
  extends: ['zukhruf/base', 'hermes/recommended'],
});
```

If the app installs an npm polyfill that has a Node module's name, allow it: `'import-x/no-nodejs-modules': ['error', { allow: ['buffer'] }]`.

## Development

The workspace lints itself with this package's source: the root `eslint.config.mjs` imports `packages/eslint/src/index.ts`. Nx loads that config while it builds the project graph, before anything is built. A rule edit applies on the next lint.

```sh
npx nx run eslint:test        # builds, then runs the rule and composition tests
```

The composition tests run the real ESLint CLI on temporary workspaces. They load the built package, which is what consumers install.

### Add a check

A check is a rule under its own key ([ADR 0001](./docs/adr/0001-one-key-per-check.md)). Before you write a visitor by hand, use the builders in `src/authoring/`:

- `importBanRule()` bans packages and their subpaths. It reports static imports, re-exports and literal dynamic imports, type-only ones included.
- `selectorRule()` reports each node that one of its esquery selectors matches. The substring operator `*=` never matches a Literal's `value`, so write a regex selector (`[value=/…/]`).
- `scopedRule()` turns a rule on only for the files that its function accepts. Build that function from `isTestFile()`, `inRoots()` and `matchesAnyGlob()` in `path-scope.ts`. A rule finds its scope from the linted file, not from a config glob ([ADR 0002](./docs/adr/0002-scope-from-the-linted-file.md)).
- `ast.ts` has the type guards for a visitor: `isAstNode()`, `isType()` and `identifierName()`.

Folders that differ from repo to repo are `roots` options. A fact about the repo is a repo setting. A rule whose options a repo extends gets an option factory ([ADR 0004](./docs/adr/0004-option-factories.md)).

1. Put the rule in the folder of the subject that it checks, such as `src/async-values/` or `src/imports/`. The file exports the rule as its default.
2. Put `<rule>.test.ts` next to it. Use `typescriptRuleTester()` from `src/testing/rule-tester.ts`, or `typedRuleTester(root)` when the rule reads types. Call `run()` inside a node:test `test()`.
3. Add the rule to the `rules` map in the `config.ts` of its concept, and turn on `zukhruf/<rule>` in that concept's config. A new concept also goes into the `concepts` list in `src/plugin.ts`. The composition tests fail when not exactly one config turns on a rule, when a config sets a repo-owned rule, or when a shipped glob does not start with `**`.
4. Add the rule to its concept's row in the Configs table. Below the table, write a paragraph that tells why the check exists.
5. Fix the findings that the new rule reports in the other packages of this workspace, in the same commit (for example 20b34e0). The workspace lints itself with this source. When a package must keep its code, turn the rule off for those files in the root `eslint.config.mjs`, with a comment that tells why (for example 495f19d).
6. Run `npx nx run eslint:test` and `npx nx run eslint:typecheck`.
