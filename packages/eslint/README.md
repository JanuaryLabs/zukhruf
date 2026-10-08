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

| Config            | Files                 | Rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`            | all source            | `@eslint/js` and `typescript-eslint` recommended; `consistent-type-assertions` (never), `no-namespace`, `zukhruf/no-enum`; `import-x/no-duplicates`, `import-x/no-unassigned-import`; `functional/no-let` (module scope); `zukhruf/no-state-managers`, `zukhruf/no-playwright-test`; typed lint: `no-floating-promises`, `no-misused-promises`, `only-throw-error`, `switch-exhaustiveness-check` (a `default` counts as exhaustive), `zukhruf/no-promise-field`, `zukhruf/no-phase-flag` |
| `tests`           | test files            | `no-test-lifecycle-hooks`, `require-msw-error-on-unhandled-request`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `diagnostics`     | source, not tests     | `no-fabricated-fallback`, `no-hardcoded-id-shape`, `consistent-event-name`                                                                                                                                                                                                                                                                                                                                                                                                                |
| `env`             | TypeScript, not tests | `no-undeclared-process-env`, `no-single-env-read-wrapper`, `no-default-for-path-env`                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packaged-app`    | TypeScript, not tests | `no-bare-spawn`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `react`           | `.tsx`, `.jsx`        | `require-combobox-popover-modal`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `react-router`    | source                | `require-loader-data-type-argument`; outside tests: `no-raw-route-path`, `no-internal-anchor`                                                                                                                                                                                                                                                                                                                                                                                             |
| `hono`            | TypeScript, not tests | `no-untyped-empty-json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tailwind`        | source                | `no-h-screen`, `no-arbitrary-z-index`, `no-will-change`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pulumi`          | TypeScript            | `require-server-replace-guard`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `nx-project-json` | `project.json`        | `no-missing-asset-input`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

`base` turns on typed lint (`parserOptions.projectService`). Each linted TypeScript file must be in a tsconfig.

`zukhruf/no-promise-field` reads each class field's type, so it also sees a promise behind an alias, in a type argument (`Map<string, Promise<X>>`), or inferred from the initializer. A field that holds a function returning a promise is fine: that is a memoized function. To wait until something has happened, use a state object or a one-shot latch.

`zukhruf/no-phase-flag` reads each class field's type too. It reports a field that is a boolean, or that can be `undefined`, when code outside the constructor sets it. A callback that the constructor creates runs later, so its assignment counts as outside. Such a field records a phase, and every reader must know which phase holds. Push the fact as an event, wait on a one-shot latch, keep the phases in state objects, or ask the platform for the fact.

### Options for a repo

Give repo-specific values as rule options. For example:

```js
{
  rules: {
    'zukhruf/no-bare-spawn': ['error', { roots: ['apps/desktop/src'] }],
    'zukhruf/no-undeclared-process-env': ['error', { startupFile: 'src/env.ts' }],
  },
}
```

`roots` are folders relative to the workspace root. A rule finds the workspace root from the linted file: the nearest folder with `nx.json`, `pnpm-workspace.yaml`, or a `package.json` that declares `workspaces`.

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

The rule reads the build target as Nx resolves it: `project.json`, the target defaults in `nx.json`, and the targets that Nx plugins infer. An application bundles unless its build is `nx:noop`, or esbuild with `bundle: false`.

An esbuild app can name workspace packages in `external`. Its build does not inline those packages, so they come from `node_modules` when the app runs. When the app imports one of them, it is unbundled, and its manifest declares them. Its manifest does not declare the workspace packages that its build still inlines. The rule reads the list that Nx gives esbuild: `external` and `esbuildOptions.external`, less the entries in `excludeFromExternal`. A `*` in an entry is esbuild's wildcard, as in `@acme/*`.

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
