/**
 * Personal ESLint config.
 *
 * A growing manifest of non-negotiables: mostly *taste* rules (how I want code
 * to read), plus a few bug-prevention rules I always want enforced. Imported as
 * the final layer of the root `eslint.config.mjs`, so it applies workspace-wide
 * to every `nx run <project>:lint`.
 *
 * Every rule here is portable (built-in / `@typescript-eslint` / plugins) and
 * works in any repo. Add new rules here, each with a one-line rationale. Over
 * time this file is the readable record of how I like to write code.
 *
 * Note: `eslint-plugin-import-x` is used instead of `eslint-plugin-import` —
 * the classic plugin peer-caps at eslint ^9 and this repo runs eslint 10.
 */
import functional from 'eslint-plugin-functional';
import importX from 'eslint-plugin-import-x';

export default [
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts'],
    rules: {
      // No type assertions. `as X` papers over a type error instead of fixing
      // the root cause: understand *why* the types disagree and restructure so
      // TypeScript narrows on its own. Two canonical fixes this rule pushes you
      // toward:
      //   - Prefer imperative assignment over conditional spreads when a strict
      //     type rejects an inferred union.
      //   - For discriminated unions, narrow with control flow
      //     (`if (result.status === 200) { ... }`) instead of
      //     `(result.data as { ... }).value` — note `assert.equal(status, 200)`
      //     does NOT narrow the type, only a real `if` guard does.
      // `as const` (const assertions) and `satisfies` stay allowed.
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'never' },
      ],

      // No value `namespace` blocks — they need a runtime transform and break
      // Node's strip-only `.ts` execution (tsc/bundlers hide it). Ambient
      // `declare global { namespace NodeJS { ... } }` env typing is the only
      // legit use and is exempted per-site with an eslint-disable comment.
      '@typescript-eslint/no-namespace': 'error',
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    rules: {
      // Banned imports. Owned here so this portable taste layer is the single
      // source of truth — flat config REPLACES rather than merges rule options,
      // so the rule cannot be split across two config layers without one
      // silently wiping the other.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'zustand',
                'zustand/*',
                'jotai',
                'jotai/*',
                'redux',
                '@reduxjs/toolkit',
                'react-redux',
                'mobx',
                'mobx-react',
              ],
              message:
                'No external state managers. Use TanStack Query (server state), React Context (shared UI state), or URL state (shareable state).',
            },
            {
              // @deepagents/agent is legacy. Compose with @deepagents/context
              // (fragments, engine, store) + the AI SDK directly — never the
              // supervisor/swarm/pipe/handoff patterns from the old package.
              group: ['@deepagents/agent', '@deepagents/agent/*'],
              message:
                '@deepagents/agent is legacy. Build with @deepagents/context + the AI SDK directly.',
            },
            {
              // node:test is THE workspace runner.
              group: ['@playwright/test', '@playwright/test/*'],
              message: 'Use node:test.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    plugins: { 'import-x': importX },
    rules: {
      // Two `import ... from 'x'` statements for the same module compile fine
      // and read as unrelated. A codemod that appends an import to a file that
      // already imports that module produces exactly this, and nothing catches
      // it. `prefer-inline: false` keeps `import type {…}` a separate, allowed
      // statement — `verbatimModuleSyntax` is on, so type imports must stay
      // erasable on their own.
      'import-x/no-duplicates': ['error', { 'prefer-inline': false }],
      // No bare side-effect imports: `import './x.ts'` makes importing DO work,
      // hiding a registration/mutation behind module evaluation order that the
      // type system can't see. A module you need must be a value you bind.
      'import-x/no-unassigned-import': 'error',
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts'],
    ignores: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.test.cts',
      '**/*.test.mts',
      // Test-support scripts, same category as the tests above: a fixture runs
      // top-level and its counters are arrange state, not module state that
      // outlives a request.
      '**/*.fixture.ts',
    ],
    plugins: { functional },
    rules: {
      // No mutable state at module scope. A module-scope `let` is a global, and
      // the second-order cost is worse than the mutation: the functions that
      // read it cannot be closures over it, so every *other* dependency they
      // need gets drilled through their signatures instead. Keep mutable state
      // inside the function or factory that owns it, and the drilled
      // parameters become closure captures.
      //
      // `allowInFunctions` keeps ordinary locals and loop counters legal — this
      // rule is about scope, not about mutation. (Note the option is
      // `allowInFunctions`; `ignoreInFunctions` belongs to a different rule in
      // this plugin and silently does nothing here.)
      'functional/no-let': ['error', { allowInFunctions: true }],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts'],
    // Typed lint. `projectService` hands each file its nearest tsconfig.json
    // (following references), so the rules below see real types under
    // `nx run <project>:lint`.
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // No floating promises. A promise nobody awaits, returns, handles, or
      // `void`s has nowhere to send its rejection. Intent is stated with
      // `void x()`, never `.catch(() => {})` — `void` keeps a real failure
      // loud, an empty catch buries it forever. node:test's
      // `test`/`it`/`describe`/`suite` return a Promise the runner owns; the
      // allow-list keeps every test file from tripping the rule.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: ['test', 'it', 'describe', 'suite'],
            },
          ],
        },
      ],
      // The gap the rule above cannot see: a promise-returning function handed
      // to a void-typed slot (`queueMicrotask(flush)`) is an expression, not a
      // statement, so its rejection vanishes the same way. checksVoidReturn
      // stays at its default (every position on); only conditionals and
      // spreads are off, since neither has a floating-rejection shape.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksConditionals: false, checksSpreads: false },
      ],
    },
  },
];
