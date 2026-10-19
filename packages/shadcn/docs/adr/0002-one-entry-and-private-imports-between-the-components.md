# One entry, and private imports between the components

An app imports the components of this package. The components also import each other: for example, `dialog.tsx` imports `Button` from `button.tsx`. The CLI writes these imports with the `aliases` of `components.json`, for example `#components/button`. The imports must resolve in the generated source, in `dist` after the build, and in the bundler of the app.

The package has one entry, `@zukhruf/shadcn`. The sync writes `src/index.ts` with one `export * from './components/<name>.tsx';` line for each component, and one line for each hook. The maintainer selected one entry: an app writes one import path for all components.

Some values are in the generated source, but the generated source does not export them. For example, `sidebar.tsx` writes its open state in the cookie `sidebar_state`, but it does not export `SIDEBAR_COOKIE_NAME`. An app needs the name to read the cookie on the server. A hand edit of `sidebar.tsx` is lost at the next sync ([ADR 0001](./0001-the-shadcn-cli-writes-the-source-and-the-commit-pins-it.md)). Thus a person writes the value in a hand-written module in `src/hand-written`. The sync writes one `export * from './hand-written/<name>.ts';` line for each file in that folder. Each hand-written module has a test. The test fails when the value is not the same as the value in the generated source. For example, `sidebar-cookie.test.ts` clicks `SidebarTrigger` and finds a cookie with the name `SIDEBAR_COOKIE_NAME`.

The components import each other through private imports. The `imports` field of `package.json` maps `#components/*`, `#lib/*` and `#hooks/*` to files, with one condition for each target:

- `@zukhruf/source` gives the file in `src`, for the tools of this workspace.
- `types` gives the `.d.ts` file in `dist`.
- `default` gives the `.js` file in `dist`.

Node.js calls this feature subpath imports. Only files in the package can resolve a `#` specifier, so a private import is not public API. Node.js, Vite, webpack, esbuild and Rollup resolve them. The TypeScript compiler resolves them through the `paths` of `tsconfig.lib.json`. The shadcn CLI accepts `#` aliases since version 4.7.0, with `moduleResolution: bundler`. It refuses relative aliases.

## Considered Options

- **One subpath for each component**, for example `@zukhruf/shadcn/button`. A component could then import another component through its subpath. The maintainer refused this: the package has one entry.
- **A self-reference**: a component imports another component through the name of the package. A self-reference resolves only through the `exports` field, so each component would need a public subpath again.
- **Relative aliases** in `components.json`, for example `./src/components`. The shadcn CLI refuses them.
- **Private imports.** They stay inside the package, and the entry stays the one public path. This option was selected.

## Consequences

- An app imports each component from `@zukhruf/shadcn`.
- A development server and plain Node.js load all components and all their dependencies, also for an app that uses one component. The maintainer accepted this cost.
- A production bundle has only the components that the app uses. `sideEffects` in `package.json` tells the bundler that only the CSS files have side effects, so the bundler removes the unused components.
- Two components that export the same name make the type check fail (TS2308). A probe on 2026-10-15 found 388 names in the components, and no name two times. A sync that adds a second copy of a name fails the type check, and a person must resolve it.
- The entry does not export `cn`. Each symbol has one home ([zukhruf ADR 0001](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md), rule 6). An app imports `cn` from the `cn` package.
- The private imports keep the shared code inside this package. zukhruf has no internal package (zukhruf ADR 0001, rule 8).
