# zukhruf is a layered standard library

zukhruf is a standard library of small packages, in the way of the standard libraries of Go, Rust and Deno. Each package does one thing, and a project can use it alone. The packages import each other in layers. The shipped code of a layer imports only the layers below it, so a change at the top cannot break the bottom. The tools are a layer apart: only tools and test files import them.

Without a check, the layers decay: each import that crosses a layer looks harmless alone. Go writes its layers as a test, [`go/build/deps_test.go`](https://github.com/golang/go/blob/master/src/go/build/deps_test.go), which lists the packages that each package may import. The CI of the Deno standard library refuses an import cycle between its `@std` packages, and a stable package that imports an unstable package. This workspace already runs `@nx/enforce-module-boundaries` in `nx lint`. Thus each project gets a layer tag, and the root `eslint.config.mjs` says which layers each layer may import.

## The layers

| Layer        | Tag                | Projects                                                   | Shipped code may import        | Test files may also import |
| ------------ | ------------------ | ---------------------------------------------------------- | ------------------------------ | -------------------------- |
| Base         | `std:base`         | `async`, `fs`, `lease`, `fencing`, `snapshot-differential` | Base                           | Tool                       |
| Coordination | `std:coordination` | `election`                                                 | Base                           | Tool                       |
| Domain       | `std:domain`       | `mutex`, `single-flight`                                   | Base, coordination             | Tool, domain               |
| Tool         | `std:tool`         | `testing`, `eslint`                                        | Tool                           | Nothing more               |
| UI           | `std:ui`           | `shadcn`                                                   | Nothing                        | Tool                       |
| Host         | `std:host`         | `apps/reservation-app`                                     | Base, coordination, domain, UI | Tool                       |

A base package imports Node.js and other base packages only. For example, `fencing` imports `fs` and `lease`. The election is a layer of its own, because the domain packages build on it, and it builds on the base packages.

The UI layer holds React components for an app. Its shipped code imports no zukhruf package: the components need only React, Base UI and Tailwind CSS. A host can import the UI layer.

A test file is a `*.test.*` or `*.spec.*` file, or a file in `src/testing`, which holds the test helpers. The build does not ship these files. Thus a test file may also import the tools, and the test of a domain package may run another domain package. For example, a test of the single flight runs the socket lock store of the mutex.

The lint checks direct imports only. A host that imports the mutex does not also need the tools, although the tests of the mutex import them.

Each package also keeps its `layer:island` tag. That tag answers a different question: the package imports no runtime of a host, such as Hono or Electron.

## The rules that put code into a package

1. **A package has one concept.** Its name says what it does (`fs`, `lease`), not who uses it. Two concepts that exist without each other are two packages. A lease and a fencing token are an example: an election gives a lease with no token, and Kafka refuses an old producer with no lease ([lease ADR 0001](../../packages/lease/docs/adr/0001-a-lease-is-its-own-package-apart-from-fencing.md)).
2. **Code moves into one home at the third place that does the same thing.** This is the Rule of Three of Fowler, in _Refactoring_: "The third time you do something similar, you refactor." The count is the number of places, not the number of packages. Two places inside one package count as two. Two copies stay copies, also when they are identical. A ledger lists each copy and what changed in it, and a backlog item waits for the third place. Thus three working copies give the boundary of the shared code, and not a guess. The rule has two recorded exceptions:
   - **Test helpers stay copied**, also after the third copy. The maintainer chose this for the helpers that the mutex, the single flight and the election copy ([election copied code](../../packages/election/docs/copied-code.md)).
   - **The election moved into its own package at the second copy.** The maintainer chose this, because its boundary was already clear ([election ADR 0001](../../packages/election/docs/adr/0001-leader-election-is-a-package-and-each-backend-is-a-subclass.md)).
3. **The Rule of Three counts copies, not imports.** A module that other modules import is not a copy. A move of such a module to a better home is a question of cohesion, and it can occur at any time.
4. **A tiny helper stays a copy** when one home would give a package a dependency that it does not have. A Go proverb says: "A little copying is better than a little dependency."
5. **A type that two domain packages share moves down a layer.** A domain package never imports another domain package in its shipped code. For example, the lease and the fencing token moved from the mutex into `lease` and `fencing`, so the single flight does not import the mutex.
6. **Each symbol has one home.** A package does not export a symbol of another package, with one exception: a package exports the error class that its own API produces. Then a catch with `instanceof` works with the package that the caller imports ([fs ADR 0001](../../packages/fs/docs/adr/0001-the-writes-through-a-draft-are-one-package.md)). For example, the mutex, the election and the single flight export `LeaseLostError` of `lease`. Go does the same: `os.PathError` is an alias of `fs.PathError`.
7. **A package lists another zukhruf package as a dependency, not as a peer.** The packages release together with one version, so a dependency never gives two versions that do not agree. A peer makes each user install the package by hand.
8. **There is no internal package.** npm has no private package: each published package is public, and users find it. Deno publishes `@std/internal` for its own packages, and only a note asks other users not to import it. Code that only one package needs stays in that package.

## Considered Options

- **No layers.** The packages are islands already, so they import no host runtime. But nothing stops a base package from importing a domain package.
- **One package, with an import path for each area**, as the `std` of Go and of Rust. The packages need different dependencies: `testing` brings database drivers, and `eslint` brings ESLint. One package gives all of them to each user.
- **A list of allowed imports for each package**, as Go's `deps_test.go`. With ten projects, five layers say the same thing with fewer entries.
- **Layers, checked by `@nx/enforce-module-boundaries`.** This option was selected.

## Consequences

- An import across layers fails `nx lint`. For example, the message for a base package is `A project tagged with "std:base" can only depend on libs tagged with "std:base"`. An import that makes a cycle fails with the cycle message first.
- A new package gets a layer tag before its first import of another package.
- Test files have their own table. A flat-config block replaces the options of a rule ([eslint ADR 0004](../../packages/eslint/docs/adr/0004-option-factories.md)), so each of the two blocks has the whole table, the island constraint and the shared entries of `moduleBoundaries()`.
- The table is in the root `eslint.config.mjs`, not in `@zukhruf/eslint`. Only this workspace has these layers.
