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

Its peers are `eslint`, `@eslint/js`, `typescript-eslint`, `typescript`, `eslint-plugin-import-x`, `eslint-plugin-functional` and `jsonc-eslint-parser`. `@zukhruf/eslint/nx` also needs `@nx/eslint-plugin`, `@zukhruf/eslint/react` needs `react` and the 3 plugins in [React](#react), and `@zukhruf/eslint/react-native` needs `eslint-plugin-es-x`. npm installs the peers for you. With `legacy-peer-deps=true` in `.npmrc`, npm does not, so add them to your devDependencies.

```js
// eslint.config.mjs
import { defineConfig } from 'eslint/config';

import zukhruf from '@zukhruf/eslint';

export default defineConfig({
  plugins: { zukhruf },
  extends: ['zukhruf/base', 'zukhruf/tests'],
});
```

Put framework configs (for example [`@zukhruf/eslint/react`](#react)) **before** the zukhruf configs. The package's own checks survive any order. But `base` also changes some third-party rules, for example it turns `@typescript-eslint/no-unused-vars` off, and a preset that comes later sets them again.

## Configs

| Config            | Files                                 | Rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`            | all source                            | `@eslint/js` and `typescript-eslint` recommended; `consistent-type-assertions` (never), `no-namespace` (a `declare` namespace allowed), `zukhruf/no-enum`, `no-empty-object-type` (an interface that extends one type allowed, such as `ProcessEnv` in `env.ts`; `no-empty-interface`, which it replaced, is off); `import-x/no-duplicates`, `import-x/no-unassigned-import` (allows `**/*.css`, `**/env.ts` and `**/startup.ts`); `functional/no-let` (module scope); `zukhruf/no-state-managers`, `zukhruf/no-playwright-test`, `zukhruf/no-other-test-runner`, `zukhruf/no-test-file-import`, `zukhruf/no-raw-database-sync`, `zukhruf/no-collect-loop`; typed lint: `no-floating-promises`, `no-misused-promises`, `only-throw-error`, `switch-exhaustiveness-check` (a `default` counts as exhaustive), `no-deprecated`, `zukhruf/no-promise-field`, `zukhruf/no-phase-flag`; `no-require-imports` is off in `.cjs` and `.cts`, because `require()` is the only import form in a CommonJS file |
| `tests`           | test files, `src/testing`             | `no-test-lifecycle-hooks`, `no-process-env-write`, `no-direct-msw-server`, `no-catch-all-msw-handler`, `no-timer-race`, `no-sleep-poll-loop`, `no-global-test-mock`, `no-raw-temp-directory`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `diagnostics`     | source, not tests                     | `no-fabricated-fallback`, `no-hardcoded-id-shape`, `consistent-event-name`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `env`             | TypeScript, not tests or tool configs | `no-undeclared-process-env`, `no-single-env-read-wrapper`, `no-default-for-path-env`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packaged-app`    | TypeScript, not tests                 | `no-bare-spawn`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `react`           | `.tsx`, `.jsx`                        | `no-as-child`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `react-router`    | source                                | `require-loader-data-type-argument`; outside tests: `no-raw-route-path`, `no-internal-anchor`; TypeScript: `only-throw-error` allows a `Response` and `DataWithResponseInit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `hono`            | TypeScript, not tests                 | `no-untyped-empty-json`, `no-http-exception-factory`, `no-catch-around-next`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `better-auth`     | TypeScript, not tests                 | `no-api-error-instanceof`, `no-on-api-error-throw`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tailwind`        | source                                | `no-h-screen`, `no-arbitrary-z-index`, `no-will-change`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pulumi`          | TypeScript                            | `require-server-replace-guard`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `nx-project-json` | `project.json`                        | `no-missing-asset-input`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

`base` turns on typed lint (`parserOptions.projectService`). Each linted TypeScript file must be in a tsconfig.

`@typescript-eslint/no-deprecated` reports a use of an API that its package marks `@deprecated`. The note names the replacement, so move to it while the change is small. A repo that must keep a deprecated API for a time sets the rule's `allow` option in its own config, in a block for the files that need it, with the reason. Give a name for a value of a plain type, such as a boolean option. Give `{ from: 'package', package, name }` for a type that the package declares.

`zukhruf/no-promise-field` reads each class field's type, so it also sees a promise behind an alias, in a type argument (`Map<string, Promise<X>>`, `Record<string, Promise<X>>`), in a union or an intersection, in a `PromiseWithResolvers`, or inferred from the initializer. It also looks inside a record that the project declares, such as `Map<string, { key: string; answer: Promise<boolean> }>`, up to four properties deep. It stops at a class, because the rule checks the fields of that class on their own, and at a library's type, because its promises belong to the library. A field that holds a function returning a promise is fine: that is a memoized function. A record of functions that settle a promise, `{ resolve, reject }`, is fine too: the caller keeps the promise. To wait until something has happened, use a state object or a one-shot latch. See [ADR 0006](./docs/adr/0006-no-promise-field-stops-at-the-class-boundary.md).

`zukhruf/no-phase-flag` reads each class field's type too. It reports a field that is a boolean, or that can be `undefined` or `null`, when code outside the constructor sets it. A callback that the constructor creates runs later, so its assignment counts as outside. Such a field records a phase, and every reader must know which phase holds. Push the fact as an event, wait on a one-shot latch, keep the phases in state objects, or ask the platform for the fact.

The rule also reports a `let` with the same types when a function that its function returns sets it. Such a function runs after the return, as a method runs after the constructor: a method of the returned object or class, a returned function, or the cleanup that a React effect returns. Thus `let closed = false; return { close() { closed = true; } }` is reported. A callback that the function calls before it returns, such as the callback of `map`, is not reported. A `let` that only its own function body sets is not reported.

A lazy memo is not a phase, so the rule does not report it. In a lazy memo, each write is `x ??= …` (for a field, the private `this.#x ??= …`), so the value never becomes empty again. Each read is the value of that `??=`, or comes after an `x ??= …;` statement at the top level of the same function body, as in `this.#x ??= build(); return this.#x;` or `return () => (value ??= read());`. A field or `let` that has `??=` writes but no read is a flag, and the rule reports it.

`zukhruf/no-test-lifecycle-hooks` keeps the arrange and the teardown of a test in that test. A hook moves them out, so the reader does not see the full test, and the state that one test leaves can reach the next test. A per-test `t.after()` of node:test also moves the teardown out of the flow of the test. The rule reads the names of the scope, not only the text. It reports a hook from the Vitest, Jest or Mocha globals, and from an import, also under a different name (`import { after as cleanup }`). It reports a hook on `test` or `it` of node:test, or on its namespace (`test.after()`). It reports a hook on a test context: the first parameter of a test callback or a subtest callback of node:test, or a parameter of the type `TestContext`. A function of the file that has the name `after` is not a hook. Put the teardown in `try`/`finally`, or use `await using` with a disposable.

`zukhruf/no-raw-database-sync` reports `new DatabaseSync` of `node:sqlite`. Each such open sets up its connection in its own way: its busy timeout, its journal, and which errors mean that the file is missing or denied. `open(path, options)` of `@zukhruf/sqlite-open` takes the same options and does that setup in one place; a reader is `open(path, { readOnly: true })`. The rule follows the bindings of the file: a named import under any local name, a namespace or default import, and `require` or `import()` of `node:sqlite`. A type-only import constructs nothing, so the rule does not report it. Turn it off only where a package cannot depend on `@zukhruf/sqlite-open`, and write the reason beside the override.

`zukhruf/no-http-exception-factory` reports a function that only returns `new HTTPException(…)`. The function hides the status and the cause code behind a name, so the reader of the throw site cannot see what the client gets. Write `throw new HTTPException(status, { message, cause: { code, detail } })` in full at each throw site, also when many sites use the same code. A function with more statements than the `return`, such as a branch, stays. A lookup in the arguments of the exception does not change the result: put the lookup in a function of its own, and keep the exception at the throw site. A class method that returns the exception, such as `toHTTPException()`, also stays: each class translates its own error.

`zukhruf/no-catch-around-next` reports the `catch` of a `try` block that only calls `await next()` or `return next()`. Hono's `compose()` catches the error of each handler and gives it to the app's error handler. An app always has an error handler, because Hono adds a default one. Thus `next()` does not reject with an `Error`, and the `catch` never runs. Translate the error at the throw site, or read `c.error` after `next()`. The rule applies only to a file that imports `hono` or `hono/*`. In Koa, the same `catch` is the error handler that the Koa documentation shows.

`zukhruf/no-api-error-instanceof` reports `instanceof APIError` when `APIError` comes from `better-auth`, `better-auth/api`, `@better-auth/core/error`, `better-call` or `better-call/error`. The `APIError` of better-auth extends the `APIError` of better-call. Thus an `APIError` that better-call throws is not an instance of the better-auth class, and the error goes to the 500 path. Use `isAPIError(error)` from `better-auth/api`. It checks the two classes and the name of the error. An `APIError` from a different module, such as a generated client, is not reported.

`zukhruf/no-on-api-error-throw` reports `onAPIError: { throw: true }`. With this option, better-auth throws the error again before `onAPIError.onError` and before its own log. The router of better-call catches that error and makes a response from it, so the error handler of the app does not run, and no log shows a 4xx error. Log the error in `onAPIError.onError`.

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
import { noFloatingPromises, noLet, noUnassignedImport } from '@zukhruf/eslint';

{
  rules: {
    'functional/no-let': ['error', noLet({ ignoreIdentifierPattern: ['^cached'] })],
    '@typescript-eslint/no-floating-promises': ['error', noFloatingPromises({ allowForKnownSafeCalls: [/* … */] })],
    'import-x/no-unassigned-import': ['error', noUnassignedImport({ allow: ['**/exceptions.ts'] })],
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
- `island/no-process-env`, `island/no-console` and `island/jsdom-virtual-console` in islands and in the files that `settings.island.libraries` names. jsdom's default virtual console writes a page's errors to the host's `console.error`, so each `new JSDOM(…)` from `jsdom` sets `virtualConsole` in its options literal.
- `island/no-ambient-time` in islands and in the files that `settings.island.libraries` names. A library that waits on a timer or reads the time takes the clock from its caller, so that a test can give it a fake clock and move the time ([zukhruf root ADR 0004](../../docs/adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md)). The rule reports `Date.now`, `performance.now`, `process.hrtime`, `AbortSignal.timeout` and `Temporal.Now`, called or as values (`now = Date.now`), `new Date()` and `Date()` with no argument, `setTimeout` and `setInterval` as calls or values (`promisify(setTimeout)`), the same through `globalThis` or `global`, an import of `setTimeout`, `setInterval` or `scheduler` from `node:timers` or `node:timers/promises`, and an import of `performance` from `node:perf_hooks`. A dynamic `import()` or `require()` of these modules, and a global that a destructure renames (`const { Date } = globalThis`), are not reported. It does not report a call on a clock (`clock.setTimeout(…)`), `globalThis` given as a clock (`delay(ms, { clock: globalThis })`, as an app or a real deadline does), `setImmediate` (a turn of the event loop, not a time), or `new Date(value)`. A name that a local binding shadows passes.
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

`manifest/recommended` also has `manifest/no-truncated-description`. The npm registry keeps only the first 255 characters of a package's `description`. `npm view` and the npm search do not show the rest. The rule reports a `description` that is longer than 255 characters. It does not check a manifest with `"private": true`, because npm does not publish it. Put the key fact in the description, and put the details in the README.

## React

`@zukhruf/eslint/react` gives the configs that the React community maintains. The package adds no rule of its own to them and changes no severity. Use it in the `eslint.config.mjs` of a React project. Put it first, and then the root config, as before:

```js
import react from '@zukhruf/eslint/react';

import baseConfig from '../../eslint.config.mjs';

export default [...react, ...baseConfig];
```

The configs apply only to TypeScript files, the files to which `zukhruf/base` gives type information. Thus they do not lint the `package.json` or the other files of a project.

It gives these configs, in this order:

1. `recommended` of `eslint-plugin-jsx-a11y-x`: the accessibility rules. This plugin is the maintained fork of `eslint-plugin-jsx-a11y`, and its peer range includes ESLint 10.
2. `flat.recommended` of `eslint-plugin-react-hooks`: the rules of the React team.
3. `recommended-type-checked` of `@eslint-react/eslint-plugin`: the React rules, for example `@eslint-react/no-missing-key`. The rules use type information. `zukhruf/base` gives it, because it sets `projectService`.
4. `disable-conflict-eslint-plugin-react-hooks` of `@eslint-react/eslint-plugin`: it turns off the 12 rules of `eslint-plugin-react-hooks` that `@eslint-react/eslint-plugin` also has.
5. `strict` of `eslint-plugin-react-you-might-not-need-an-effect`: its 10 rules report an effect that React does not need, for example state derived from props or an event handler run from an effect. `strict` makes each rule an error.

Thus `@eslint-react/eslint-plugin` owns the hook rules, for example `@eslint-react/rules-of-hooks` and `@eslint-react/exhaustive-deps`, and ESLint reports each problem one time. This is the path of the eslint-react guide "Migrating from eslint-plugin-react-hooks". `eslint-plugin-react-hooks` adds only its 4 React Compiler rules: `preserve-manual-memoization`, `incompatible-library`, `config` and `gating`. Each rule of the first 4 configs has the severity that its plugin ships.

The style rules of zukhruf for React are not in this export. They are in the config `zukhruf/react`.

Install the 4 plugins in the React workspace:

```sh
npm install --save-dev @eslint-react/eslint-plugin eslint-plugin-jsx-a11y-x eslint-plugin-react-hooks eslint-plugin-react-you-might-not-need-an-effect
```

They are optional peers of this package. With the peers, npm writes the lockfile edges from `@zukhruf/eslint` to the 3 plugins, so a lint input on `@zukhruf/eslint` also hashes the plugins.

`react` is also an optional peer, because the React version changes the lint result. `@eslint-react/eslint-plugin` reads the version of the `react` package that resolves from the folder where ESLint runs. `nx lint` runs ESLint in the project folder, and a hoisted `react` resolves from there. With the peer, a lint input on `@zukhruf/eslint` also hashes the React version.

## React Native: Hermes

`@zukhruf/eslint/react-native` needs `eslint-plugin-es-x`. es-x 10 needs ESLint 10.6 or later; on ESLint 9, install `eslint-plugin-es-x@9`. `hermes/recommended` checks the code that ships in the app, and leaves tests, config files and scripts alone, because those run in Node:

- the `Intl` APIs Hermes does not have: es-x's `no-intl-displaynames`, `no-intl-durationformat`, `no-intl-listformat`, `no-intl-locale`, `no-intl-pluralrules`, `no-intl-relativetimeformat` and `no-intl-segmenter`;
- Node's built-in modules: `import-x/no-nodejs-modules`;
- `hermes/no-missing-console`: `console.clear`, `dir`, `dirxml`, `profile`, `profileEnd` and `timeLog`, which React Native release builds do not have, and `console[name]` with a computed name.
- `hermes/no-compact-notation`: `notation: 'compact'` and `compactDisplay` in the options of `Intl.NumberFormat`, which Hermes on iOS ignores: `format(44000)` gives `44,000`, not `44K`. Build the short form yourself.

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
- `selectorRule()` reports each node that one of its esquery selectors matches. The substring operator `*=` never matches a Literal's `value`, so write a regex selector (`[value=/…/]`). A `:has(> A > B)` with more than one level never matches, so nest it: `:has(> A:has(> B))`.
- `scopedRule()` turns a rule on only for the files that its function accepts. Build that function from `isTestFile()`, `inRoots()` and `matchesAnyGlob()` in `path-scope.ts`. A rule finds its scope from the linted file, not from a config glob ([ADR 0002](./docs/adr/0002-scope-from-the-linted-file.md)).
- `ast.ts` has the type guards for a visitor: `isAstNode()`, `isType()` and `identifierName()`.

Folders that differ from repo to repo are `roots` options. A fact about the repo is a repo setting. A rule whose options a repo extends gets an option factory ([ADR 0004](./docs/adr/0004-option-factories.md)).

1. Put the rule in the folder of the subject that it checks, such as `src/async-values/` or `src/imports/`. The file exports the rule as its default.
2. Put `<rule>.test.ts` next to it. Use `typescriptRuleTester()` from `src/testing/rule-tester.ts`, or `typedRuleTester(root)` when the rule reads types. Call `run()` inside a node:test `test()`.
3. Add the rule to the `rules` map in the `config.ts` of its concept, and turn on `zukhruf/<rule>` in that concept's config. A new concept also goes into the `concepts` list in `src/plugin.ts`. The composition tests fail when not exactly one config turns on a rule, when a config sets a repo-owned rule, or when a shipped glob does not start with `**`.
4. Add the rule to its concept's row in the Configs table. Below the table, write a paragraph that tells why the check exists.
5. Fix the findings that the new rule reports in the other packages of this workspace, in the same commit (for example 20b34e0). The workspace lints itself with this source. When a package must keep its code, turn the rule off for those files in the root `eslint.config.mjs`, with a comment that tells why (for example 495f19d).
6. Run `npx nx run eslint:test` and `npx nx run eslint:typecheck`.
