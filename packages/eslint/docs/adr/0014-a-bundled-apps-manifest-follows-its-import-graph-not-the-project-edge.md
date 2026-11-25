# A bundled app's manifest follows its import graph, not the project edge

Status: Proposed (#5565). Ezz accepts zukhruf ADRs himself.

A bundled app's manifest declares the npm packages that its bundle loads (ADR 0005). `manifest/dependency-checks` gave Nx's rule `includeTransitiveDependencies` for such an app. Nx then reads every file of each project that a project edge reaches (`@nx/js` `find-npm-dependencies.js:13-36`). A bundler does not load a package that way. It loads modules one at a time, from the app's own files and through the `exports` subpath that each import names. Meddit's backend imports `@meddit/evidence-retrieval` and its `./pubmed` subpath. Only `./dailymed` imports `yauzl` and `@xmldom/xmldom`, which that package lists as optional peers of the subpath. The rule still demanded both in `apps/backend/package.json` (Meddit #5507).

Nx's file map cannot answer this by itself. Each file lists the npm packages and the workspace projects that it imports, with no file-to-file edge and no subpath.

## Decision

For a bundled app, the rule walks the app's module graph and passes the files that the bundle never loads to Nx's rule as `ignoredFiles`. Nx then computes the demanded set itself, from the loaded files only. The walk is `BundleReach` (`src/manifest/bundle-reach.ts`):

- It starts at the app's files that Nx's rule reads: the build target's inputs (`getTargetInputs`, `filterUsingGlobPatterns`), less `ignoredFiles`. Test files are not roots.
- It reads each module's imports with `ts.preProcessFile`: static, type-only, `export … from`, side-effect, a literal `import()` and `require()`. Following a type-only import counts more, never less, as Nx counts `import type` today.
- A relative import leads to the file the bundler finds in Nx's file map (`.js` → `.ts`, extensions, `index`). A workspace package import leads through that package's `exports`: the exact key, or the pattern with one `*` whose prefix is the longest, under every condition; `main` and `module` when there is no `exports`. A `#x` import leads through the importing package's `imports`. `exportTargets` moved from `test-support.ts` to `package-exports.ts`, next to the new lookup.
- The result is a list of workspace-relative globs, as `testSupportFiles` already gives. A folder whose files are all unloaded becomes one `folder/**` glob. Each path has its minimatch metacharacters escaped.

**The safety rule.** A manifest that misses a package fails when the app is deployed. A manifest that lists one too many costs nothing at run time. So when the walk cannot follow something, a whole project counts, as it did before:

- a subpath that maps to no source file: all of that package;
- a `#x` import or a relative import that leads to no file in the file map, a bare specifier that is no npm package, no builtin and no workspace package (such as a tsconfig `paths` alias), and a file the walk cannot read: all of the importing project, and every workspace project that Nx's file data names for that file;
- a load by pattern (`import.meta.glob`, `new URL('…', import.meta.url)`, `require.context`, an `import()` of anything but one string literal): all of the file's project;
- a reached file that is no JavaScript or TypeScript module and can import (`.vue`, `.svelte`, `.html`): all of its project;
- a workspace project that Nx's file data names for a reached file and that no followed import accounts for: all of that project.

**The file map.** No public `@nx/devkit` API gives each file's dependencies to a rule's synchronous `create()`. `createProjectFileMapUsingProjectGraph` is async and gives no `deps`, in Nx 21, 22 and 24. Nx's own rule reads the cached file map with `readFileMapCache` of `@nx/devkit/internal`. The rule loads that module with `createRequire` and uses it only when `readFileMapCache`, `filterUsingGlobPatterns`, `getTargetInputs`, `readNxJsonFromDisk` and `fileDataDepTarget` are functions there. That holds from Nx 23.2. Nx 21 has no `@nx/devkit/internal`, and Nx 22 and 23.1 have one without these functions. There, `manifestPolicy` gets no file map and keeps the earlier result. The peer stays `@nx/devkit >=21`.

`manifestPolicy(graph, project, options, fileMap = {})` keeps its earlier result without a file map. `manifest/dependency-checks` reads the file map only for a bundled app.

## Considered Options

- **Declare the packages, or add them to `ignoredDependencies`, in Meddit.** Each one is a workaround that the next optional peer repeats. An `ignoredDependencies` entry also hides the package from the obsolete and version checks. With `ignoredFiles`, a declared `yauzl` is reported as unused when that check is on.
- **Pass the walk's result as `ignoredDependencies`.** The rule would have to compute the npm packages of the unloaded files itself, less those of the loaded ones, and it would hide them from the obsolete and version checks too. `ignoredFiles` lets Nx count, as `testSupportFiles` does.
- **Read the bundler's output, such as esbuild's metafile.** It needs a build before lint, and each bundler writes a different format.
- **Resolve with TypeScript's module resolver and the app's tsconfig.** It picks one set of conditions, which may not be the bundler's, and it costs a program per app. Flattening every condition of an `exports` entry counts more files, never fewer.

For the file map, three options were weighed:

- **A. Deep imports**, as Nx 21 and 22's own rule does: `nx/src/project-graph/nx-deps-cache`, `nx/src/hasher/task-hasher` and `nx/src/config/project-graph`. They exist at the same paths in Nx 21.0.0, 22.0.0 and 24.0.6, and Nx 24's `exports` still allows them through `./src/*`. But they are internal paths of `nx`, which is not a peer of this package.
- **B. `@nx/devkit/internal` when it has the functions, else the earlier result.** This is the module that Nx 23.2 and later's own rule reads. It never counts fewer files, and no consumer has to change. **Chosen.**
- **C. Raise the peer to `@nx/devkit >=23` and move every consumer first.** april runs `manifest/recommended` on Nx 22.7.8, and its next install would fail with ERESOLVE. The functions also arrived only in 23.2, so the floor would have to be 23.2.

## Consequences

- On Nx 23.2 and later, a bundled app no longer declares the npm packages of a subpath it never imports. Measured on Meddit's cached graph, with #5507's `evidence.ts`: `packages/evidence-retrieval/src/dailymed/**` is unloaded, `yauzl` and `@xmldom/xmldom` are no longer demanded, and nothing new is demanded. The walk took 70 ms.
- On Nx before 23.2, the rule demands what it demanded before. April keeps the over-count until it moves to Nx 23.2.
- The rule test that a bundled app declares what the published `testing/` folder of a nested project imports now has the app import that subpath. Before, the project edge alone was enough.
- A project that only an `implicitDependencies` edge reaches is unloaded as a whole, so `buildOrderOnlyPackages` is redundant for a bundled app on Nx 23.2 and later. It stays for older Nx.
