# The examples are a playground app in zukhruf

The five example diagrams (for example the homelab and the agent workflow) show each feature of the diagram on one page. [ADR 0001](./0001-the-diagram-is-a-zukhruf-package.md) kept them in the playground of text2sql, for 2 reasons:

1. One of them needed the private button of text2sql.
2. Only the playground of text2sql imported them.

Neither reason stays true. The rich content example now imports `Button` from `@zukhruf/shadcn` (text2sql `fdb390f8`). The second reason tells where the examples were, not where they must be.

The examples in text2sql cause a problem. A change to the diagram shows in the playground only after a release of zukhruf and a version change in text2sql, or after `npm link`.

The words in this document have one meaning each. See the glossary in [CONTEXT.md](../../CONTEXT.md).

## Decision

The examples move to `apps/diagram-playground` in zukhruf. text2sql deletes its copy.

- **The app is a private host.** Its tag is `std:host`, as `apps/reservation-app` has. A host can import the UI layer ([workspace ADR 0001](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md)). The app is not on npm, so the package still ships no examples.
- **The app runs on the local computer only.** No CI job deploys it, and no server hosts it.
- **The app reads the source of the packages.** Vite resolves the `@zukhruf/source` condition first. Thus `@zukhruf/diagram` and `@zukhruf/shadcn` come from their `src` folders, and an edit shows with no build. No `tsconfig` sets `customConditions`.
- **The dev server runs the React Compiler.** The source of the diagram is written for the compiler, and the package ships compiled code. The app uses the plugins of text2sql: `@vitejs/plugin-react`, the `reactCompilerPreset` in `@rolldown/plugin-babel`, and `@tailwindcss/vite`.
- **The stylesheet of the app scans the source.** The stylesheets of the packages scan `dist` only. The app reads `src`, so its stylesheet adds `@source` for `packages/diagram/src` and `packages/shadcn/src`.
- **The app has no tests.** It has no logic of its own. CI runs `lint`, `typecheck` and `build` on the app when the diagram changes, so an API change that breaks an example stops CI.

## Considered Options

- **Keep the examples in text2sql.** A change to the diagram shows there only after a release.
- **Ship the examples with the package.** ADR 0001 rejected this option, and the reason stays true: the examples are demo content, not API.
- **Storybook or Ladle.** These tools show many states of small components. The playground shows 5 whole diagrams with one toolbar. A second framework adds more than it gives.
- **A public demo site.** Not now. The maintainer wants a local tool.
- **One copy in each repository.** The two copies would change for the same reason. zukhruf keeps no copies.

## Consequences

- zukhruf gets Vite and its plugins as dev dependencies: `vite`, `@vitejs/plugin-react`, `@rolldown/plugin-babel` and `@tailwindcss/vite`.
- The app bundles the packages, so its `package.json` lists the npm packages that they import (`manifest/dependency-checks`).
- CI typechecks the examples against the current API.
- A text2sql blog author checks a diagram in its blog post. A change to `@zukhruf/diagram` itself is checked in the playground.
