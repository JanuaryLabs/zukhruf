# A preload is a file of the package, and its URL gives its settings

A test can check that a module loads in a project that did not install an optional peer dependency. Four tests in two repositories do this in a child process. They make installed packages unresolvable with a `registerHooks` hook, written as a string and given to `--import` as a `data:` URL:

- `src/areas.test.ts` and `src/node/node.test.ts` of this package.
- `packages/rpc/src/package.test.ts` and `packages/hono/src/lib/runtime/install.test.ts` of sdk-it.

The copies are different. Three of them throw an error that Node.js never throws for a package that is not installed: a plain `Error` with no code, a match of the full specifier only (so a subpath of the package stays importable), and the same error for `import` and `require`. `collectorOf` in `src/scripts/run-cleanup.ts` reads `ERR_MODULE_NOT_FOUND` to find a driver that is not installed. Under such a hook it takes a path that it never takes in the project of a consumer. ESLint and tsc do not read code in a string.

Node.js 26.10 gave these results on 2026-11-01:

- For `import`, Node.js throws `Cannot find package '<package>' imported from <path of the importer>` with the code `ERR_MODULE_NOT_FOUND`, also for a subpath. For `require`, it throws `Cannot find module '<specifier>'` with the code `MODULE_NOT_FOUND`.
- A `resolve` hook of `registerHooks` sees `import` and `require`. `context.conditions` holds `import` or `require`.
- Node.js runs each `--import` flag in order, and each `registerHooks` hook calls the hook before it.
- A module that `--import` loads from a `file:` URL with a query keeps the query in `import.meta.url`. The same URL works in `NODE_OPTIONS`.

## Decision

- A preload is a file of this package. A function of the `preload` area returns the URL of the file, and the query of the URL holds the settings. The caller gives the URL to `--import`.
- The package does not combine preloads. The caller gives one `--import` flag for each preload, and Node.js combines them.
- The first preload is `notInstalled(...packages)`. A name stops the package and each of its subpaths. The hook throws the error of Node.js: `ERR_MODULE_NOT_FOUND` for `import`, `MODULE_NOT_FOUND` for `require`.
- The function finds the file next to itself with the extension of its own URL: `.ts` when Node.js runs the source, `.js` when it runs the build. `cleanupWorker()` of `src/scripts/docker-global-setup.ts` does the same, and `docs/copied-code.md` records the two places.
- `src/node/node.test.ts` keeps its own hook. It lets only `node:` and `file:` specifiers resolve. A list of allowed specifiers is a different rule from a list of stopped packages.

## An exception to ADR 0016

[ADR 0016](./0016-a-test-helper-goes-into-an-area-when-three-repositories-have-its-knowledge-and-it-does-not-use-mock.md) puts a test helper into an area when three repositories have its knowledge. This helper is in two. On 2026-11-01 the maintainer chose to make the area. The copies throw errors that Node.js never throws, so one correct hook in one place has more value than the count.

## Considered Options

- **One function for the whole check, `withoutPackages([...])`.** The maintainer rejected the name and the shape: a primitive has one job, and it combines with other preloads.
- **A builder object that collects preloads and gives the arguments.** It does again what repeated `--import` flags do.
- **Functions that return the source of a hook, and a `preload()` function that makes a `data:` URL.** The hooks stay strings, so ESLint and tsc do not check them.
- **Each repository keeps its copy, as ADR 0016 says.** The copies keep their wrong errors.

## Consequences

- `src/areas.test.ts` uses `notInstalled`. It names packages, not subpaths, and it expects the message of Node.js.
- sdk-it uses `notInstalled` when it moves from `@zukhruf/testing` 0.3.49 to the release that has this area.
- Other preloads wait for the Rule of Three: a changed `process.platform` (`lock-stores/socket/wire-compatibility.test.ts` of `@zukhruf/mutex`), a recorder of loads (`src/exports.test.ts` of `@zukhruf/eslint`), and a fake network and clock (the startup-credits app of context-compiler). Each one would be a file and a function that returns its URL.
