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

You need ESLint 9.30 or later, and Node.js 24 or later.

```sh
npm install --save-dev @zukhruf/eslint
```

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

| Config            | Files                 | Rules                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`            | all source            | `@eslint/js` and `typescript-eslint` recommended; `consistent-type-assertions` (never), `no-namespace`, `zukhruf/no-enum`; `import-x/no-duplicates`, `import-x/no-unassigned-import`; `functional/no-let` (module scope); `zukhruf/no-state-managers`, `zukhruf/no-deepagents-agent`, `zukhruf/no-playwright-test`; typed lint: `no-floating-promises`, `no-misused-promises` |
| `tests`           | test files            | `no-test-lifecycle-hooks`, `require-msw-error-on-unhandled-request`                                                                                                                                                                                                                                                                                                           |
| `diagnostics`     | source, not tests     | `no-fabricated-fallback`, `no-hardcoded-id-shape`, `consistent-event-name`                                                                                                                                                                                                                                                                                                    |
| `env`             | TypeScript, not tests | `no-undeclared-process-env`, `no-single-env-read-wrapper`, `no-default-for-path-env`                                                                                                                                                                                                                                                                                          |
| `packaged-app`    | TypeScript, not tests | `no-bare-spawn`                                                                                                                                                                                                                                                                                                                                                               |
| `react`           | `.tsx`, `.jsx`        | `require-combobox-popover-modal`                                                                                                                                                                                                                                                                                                                                              |
| `react-router`    | source                | `require-loader-data-type-argument`; outside tests: `no-raw-route-path`, `no-internal-anchor`                                                                                                                                                                                                                                                                                 |
| `hono`            | TypeScript, not tests | `no-untyped-empty-json`                                                                                                                                                                                                                                                                                                                                                       |
| `tailwind`        | source                | `no-h-screen`, `no-arbitrary-z-index`, `no-will-change`                                                                                                                                                                                                                                                                                                                       |
| `pulumi`          | TypeScript            | `require-server-replace-guard`                                                                                                                                                                                                                                                                                                                                                |
| `nx-project-json` | `project.json`        | `no-missing-asset-input`                                                                                                                                                                                                                                                                                                                                                      |

`base` turns on typed lint (`parserOptions.projectService`). Each linted TypeScript file must be in a tsconfig.

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

## Development

The workspace lints itself with this package's source: the root `eslint.config.mjs` imports `packages/eslint/src/index.ts`. Nx loads that config while it builds the project graph, before anything is built. A rule edit applies on the next lint.

```sh
npx nx run eslint:test        # builds, then runs the rule and composition tests
npm run verify:packages       # installs the packed tarball and imports each export
```

The composition tests run the real ESLint CLI on temporary workspaces. They load the built package, which is what consumers install.
