# The diagram is a zukhruf package

The diagram was `@stdlib/diagram`, a private package in the text2sql repository. Its blog and its playground were the only users. The maintainer wants the diagram on npm, and the diagram has no concept of text2sql: it is a standard library for drawings. Thus the diagram moves to zukhruf.

The blog and the playground import the diagram. They do not copy it. A move of a module that other modules import is a question of cohesion, and it can occur at any time ([workspace ADR 0001](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md), rule 3). The Rule of Three does not apply, because there are no copies.

The words in this document have one meaning each. See the glossary in [CONTEXT.md](../../CONTEXT.md).

## Decision

The diagram is `@zukhruf/diagram`, in the UI layer (`std:ui`). Its shipped code imports no zukhruf package. text2sql deletes its package and depends on the published package.

The move changes these things:

- **The examples stay in text2sql.** The five example diagrams (for example the homelab and the agent workflow) are demo content, and only the playground of text2sql imports them. One of them needs the private button of text2sql. They move to the playground, and they import only the public API.
- **The `tier` prop is removed.** `tier` added the class `tier-wide` or `tier-full` to the wrapper element. Only the grid of the text2sql blog defines these classes. A caller now gives the classes of its page layout with `className`. The blog gives `className="tier-wide"`, as its other widgets do.
- **The stylesheet registers its own source.** The theme of the diagram is Tailwind CSS classes, for example `[--dgm-bg:#ffffff]`. Tailwind CSS makes a class only when it finds the class name in a file that it scans. Thus the package ships `styles.css` with `@source "./dist";`, and an app imports it with a plain `@import`. This is the decision of [shadcn ADR 0003](../../../shadcn/docs/adr/0003-the-stylesheet-registers-its-own-source-and-keeps-its-patches-in-layers.md), for the same reason.
- **`cn` comes from the `cn` package.** The diagram imported `cn` from the private `@stdlib/shadcn`. A UI package imports no zukhruf package, so the diagram uses the `cn` package from npm, as `@zukhruf/shadcn` does.
- **The build runs the React Compiler.** The code has 2 manual memo hooks in about 9,600 lines, because it was written for the compiler. The compiler memoizes the components, so a render does less work. text2sql already ships the compiled code. react.dev ("Compiling libraries") tells a library to ship the compiled code. The zukhruf build of other packages is plain `tsc`, so the diagram has its own build step with `babel-plugin-react-compiler`. `tsc` still writes the `.d.ts` files. The compiled code imports `react/compiler-runtime`, so the peer is `react` 19.
- **`vgpu` is a normal dependency.** The effects call the top-level `init`, `surface`, `storage`, `draw` and `frame` of `vgpu`. `@vgpu/core` does not export these functions, so it cannot replace `vgpu`. An optional peer does not work: when `vgpu` is not installed, Vite cannot resolve `import('vgpu')`, and the build of the app stops. Since `vgpu` 0.6, `draw` takes only a prepared shader. The effects prepare their shader with `prepareShader` of `@vgpu/wgsl` when they start. Thus `@vgpu/wgsl` is also a normal dependency, because the vgpu migration guide tells each package that imports it to list it. A `.wgsl` file is not an option: the loader that prepares it runs in the build of the app, and the package cannot configure that build.
- **`motion` is a peer.** `motion` keeps its state in React contexts. Two copies of `motion` in one app do not share them.

## Considered Options

- **Keep the diagram in text2sql.** One repository uses it, and a change that the blog and the diagram need together is one commit. But the diagram is not on npm, and no other project can use it.
- **Move the diagram to zukhruf.** This option was selected.
- **Ship the examples with the package.** They are demo content of one repository, and one of them needs a private package of text2sql.
- **Keep `tier`, and ship the `tier-wide` and `tier-full` classes.** The classes are part of the grid of the blog. Another app has a different grid.
- **Each app writes the `@source` for the package.** An app that forgets the line gets diagrams with no theme, and no error (shadcn ADR 0003).
- **Ship the source as TypeScript, and let the app compile it.** An app that does not run the React Compiler on `node_modules` gets code with no memoization. Then each render of a diagram does all of its work again. The effects do not start again, because `GraphFlowEffects` is in `memo` with its own comparison of the props.
- **Make `vgpu` an optional peer.** The build of an app with no `vgpu` stops.
- **Use `@vgpu/core`.** It does not have the functions that the effects call.

## Consequences

- A change to the diagram is a release of zukhruf and a version change in text2sql. A change that the blog and the diagram need together is two commits in two repositories.
- Each app installs the dependency tree of `vgpu`, also when it does not use `effects`. That tree has an MCP server, Node.js adapters and `pngjs`. The bundle of the app does not get this code: the package loads `vgpu` and `@vgpu/wgsl` with a dynamic `import()`, only for a diagram with `effects`.
- The CSS of an app has the classes of the whole package, because Tailwind CSS scans all of `dist`.
- An app must not import the stylesheet with `layer()`. The README tells this.
- zukhruf compiles with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. The move fixed the errors that these flags found, and it did not change the behavior.
- The lint rule that keeps the renderers apart moved into the root `eslint.config.mjs` (see [the internals](../internals.md)).
- The diagrams skill of text2sql keeps the advice on how to write a diagram. The API index is now in the [README](../../README.md), and the lessons about the code are in [the internals](../internals.md).
