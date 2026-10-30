# zukhruf

زخرف. A workspace of small Node.js libraries and libraries of React components.

## Packages

| Package                                                              | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@zukhruf/mutex`](./packages/mutex)                                 | A mutex with interchangeable lock stores, from one object to every process on a host, with fencing tokens on every lease.                                                                                                                                                                                                                                                                                                                                                             |
| [`@zukhruf/eslint`](./packages/eslint)                               | Shared ESLint rules and configs. Each check is its own named rule, so a repo's config cannot silently erase it. This workspace lints itself with it.                                                                                                                                                                                                                                                                                                                                  |
| [`@zukhruf/testing`](./packages/testing)                             | Disposable fixtures for integration tests: Docker containers and database servers, SQLite and DuckDB databases, HTTP servers and streams. Node's global setup and global teardown remove what a killed test run left behind.                                                                                                                                                                                                                                                          |
| [`@zukhruf/git-hooks`](./packages/git-hooks)                         | Git hooks written in TypeScript. A pre-commit hook runs steps against the staged commit: it checks the staged copy of each file with Prettier and changes nothing, runs `nx sync` and stages only the files that sync wrote, and builds generated files when nx says that their projects are affected. A pre-push hook runs steps against the push: its build step builds each pushed commit with nx in a snapshot, never the working tree. A repo adds a step of its own as a class. |
| [`@zukhruf/single-flight`](./packages/single-flight)                 | Callers of one key share the run in progress, in one process or across the processes of a host that use one directory. A second caller joins the run and gets its outcome, not a "busy" error. One process of the directory is elected the coordinator, and it pushes each outcome. Its election comes from `@zukhruf/election`, its lease from `@zukhruf/lease`, and its fencing token from `@zukhruf/fencing`.                                                                      |
| [`@zukhruf/async`](./packages/async)                                 | Helpers for code that waits for promises. `untilAborted` cancels a wait when its signal aborts, also when other code stops the abort event. `Latch` holds callers until something happened, and never rejects.                                                                                                                                                                                                                                                                        |
| [`@zukhruf/fs`](./packages/fs)                                       | File writes that a reader never sees half done: replace a file in one step, with or without a sync to the disk, or create it only when it is absent. A lock on a file that the kernel frees when its holder dies. Also refuses a directory on a network file system, and retries the short refusals of Windows.                                                                                                                                                                       |
| [`@zukhruf/election`](./packages/election)                           | Elects one leader among candidates, with a term that ends when the leader resigns or dies, and an epoch that grows with each term. `SqliteElection` elects among the processes of one host; other backends are subclasses of one campaign.                                                                                                                                                                                                                                            |
| [`@zukhruf/lease`](./packages/lease)                                 | A lease and its loss: the holder gets a signal that aborts once, with `LeaseLostError`, when another holder may have the right. An issuer gives out leases with `LeaseController`. A lease lasts for a session, not for a time.                                                                                                                                                                                                                                                       |
| [`@zukhruf/shadcn`](./packages/shadcn)                               | Each shadcn/ui component for Base UI with the nova preset, in one package. An app imports the components from one entry and the styles from one stylesheet. The shadcn CLI writes the source, and nobody edits it by hand.                                                                                                                                                                                                                                                            |
| [`@zukhruf/fencing`](./packages/fencing)                             | Fencing tokens: an integer that grows with each grant, so a resource refuses the writes of a holder that lost its lease. Token sources that count in memory, in files, or by the epoch of a leader, and the fenced lease that carries a token.                                                                                                                                                                                                                                        |
| [`@zukhruf/snapshot-differential`](./packages/snapshot-differential) | Change data capture for an upstream with no change log, such as the SQLite store of a desktop app. Each scan is compared with the last snapshot, and gives its new and changed records. A deletion policy judges each key that the scan no longer lists: deleted, unknown until a later scan can tell, or expired by a time to live.                                                                                                                                                  |
| [`@zukhruf/diagram`](./packages/diagram)                             | React components that draw technical diagrams: the graph of a system, or the timeline of a protocol. A diagram is a tree of primitives, and a renderer draws it as SVG, on a canvas, or as HTML. The theme is a set of CSS variables. The diagram can animate its parts, and draw the flow on its edges with WebGPU.                                                                                                                                                                  |
| [`@zukhruf/sqlite-drift`](./packages/sqlite/drift)                   | Declarative schema management for SQLite. A declaration lists the CREATE statements of the objects that one caller owns. The package compares them with the text that SQLite stores, and makes the database store each object as declared. No person keeps a version number.                                                                                                                                                                                                          |
| [`@zukhruf/sqlite-federation`](./packages/sqlite/federation)         | One read-only handle over many SQLite databases. Each statement attaches the databases that it names and detaches them when it ends. Thus a host can keep more databases than the attach limit of SQLite, for example one database for each data source.                                                                                                                                                                                                                              |
| [`@zukhruf/sqlite-transaction`](./packages/sqlite/transaction)       | A transaction function for `node:sqlite`. It runs work in a transaction, commits when the work returns, and rolls back when it throws. A call inside a transaction works in a savepoint. When SQLite ends the transaction itself, the caller gets the original error.                                                                                                                                                                                                                 |
| [`@zukhruf/sqlite-snapshot`](./packages/sqlite/snapshot)             | A read-only snapshot of a SQLite database that another process owns and writes. A read transaction holds one moment, so the tables agree. The file is never opened immutable, so the snapshot sees the newest rows in the WAL. It checks the columns that a reader needs.                                                                                                                                                                                                             |
| [`@zukhruf/sqlite-queue`](./packages/sqlite/queue)                   | The API of pg-boss on `node:sqlite`: a declared subset of 13 `PgBoss` methods, for a program that has no Postgres server. A parity suite runs each scenario on real pg-boss over PGlite and on SQLite, and requires the same result.                                                                                                                                                                                                                                                  |
| [`@zukhruf/sqlite-data-version`](./packages/sqlite/data-version)     | The data version of a SQLite database that another process owns and writes. It polls `PRAGMA data_version` on its own connection. The value changes on each commit by another connection, also while the owner keeps the file open.                                                                                                                                                                                                                                                   |
| [`@zukhruf/sqlite-reader`](./packages/sqlite/reader)                 | A read-only connection to a SQLite database that another process owns and writes. It opens the database with `node:sqlite`, and gives `UnavailableError` when the file is missing or the system denies access, a failure that the caller can fix.                                                                                                                                                                                                                                     |
| [`@zukhruf/sqlite-changefeed`](./packages/sqlite/changefeed)         | A changefeed of a SQLite database that another process owns and writes: a change event for each changed row of each table, keyed by its primary key, from a snapshot differential over a read-only connection. The feed keeps its own position. Needs WAL mode.                                                                                                                                                                                                                       |
| [`@zukhruf/ui`](./packages/ui)                                       | React components that an app builds from the components of `@zukhruf/shadcn`. `TheButton` is a button that shows a loading spinner after a delay, an icon, and a tooltip. `@zukhruf/shadcn` is a peer dependency.                                                                                                                                                                                                                                                                     |
| [`@zukhruf/mteb`](./packages/mteb)                                   | A TypeScript port of the evaluation engine of MTEB 2.26.28: retrieval and reranking tasks, trec_eval metrics, search, results and the result cache, with the same scores and files as MTEB. The encoder is an AI SDK embedding model.                                                                                                                                                                                                                                                 |

## Apps

| App                                               | What it does                                                                                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`reservation-app`](./apps/reservation-app)       | An HTTP app that sells the last item once, with a fenced stock table. It uses `@zukhruf/mutex`.                                                                                        |
| [`diagram-playground`](./apps/diagram-playground) | A local page that shows the example diagrams of `@zukhruf/diagram`. It reads the source of the package, so an edit shows with no build. Start it with `nx run diagram-playground:dev`. |

Each package has its own glossary. [CONTEXT-MAP.md](./CONTEXT-MAP.md) lists them.

## How the packages fit together

The packages import each other in layers: base, coordination, domain, UI, UI extension, tool and host. Each layer imports only the layers that the ADR lists for it, and `nx lint` refuses each other import. [ADR 0001](./docs/adr/0001-zukhruf-is-a-layered-standard-library.md) gives the layers and the rules that put code into a package.

## Development

```sh
npm install
npx nx run-many -t test        # builds, then runs every test
npx nx run-many -t typecheck   # formats, lints, then type checks
npx nx run <project>:test      # one project, e.g. mutex
```

## Use a package's source from another repo

Each export of a package has a `@zukhruf/source` condition first. This condition points at the source in `src/`. The other conditions point at the build in `dist/`. A repo that sets no condition gets `dist/`.

To change a package and a repo that uses it together, link the package. Then tell Node.js and TypeScript in the other repo to use the condition:

```sh
npm link                                            # in packages/<package>
npm link @zukhruf/<package>                         # in the other repo
NODE_OPTIONS=--conditions=@zukhruf/source node …    # in the other repo
```

In the `tsconfig.json` of the other repo:

```json
{
  "compilerOptions": {
    "customConditions": ["@zukhruf/source"],
    "allowImportingTsExtensions": true
  }
}
```

Node.js then runs the `.ts` files of the package, with no build. It can strip their types, because the link goes to a folder outside `node_modules`.

TypeScript then checks the source of the package with the options of the other repo. The source imports its own files with the `.ts` extension, so the other repo needs `allowImportingTsExtensions`. If the other repo emits JavaScript, use `rewriteRelativeImportExtensions` instead.

Set the condition in Node.js only while the package is linked. The published package has no `src/`, so Node.js stops with `ERR_MODULE_NOT_FOUND`. TypeScript does not stop: when the source file is not there, it uses the next condition, `types`.

The name follows the `@<scope>/source` convention of Nx and of the "live types" setup in TypeScript monorepos. The scope keeps the name unique. A repo that asks for `@zukhruf/source` gets the source of zukhruf packages only, and not of other packages that define a plain `source` condition. The name is not `development`, because bundlers such as Vite set `development` for every consumer.

## Release

Releases need no command. The packages that Nx tags `npm:public`, because their package.json is not private, are released together, as their conventional commits on `main` ask: a `feat`, `fix` or `refactor` bumps the patch version while the major version is 0, and `chore`, `docs`, `test` and `ci` release nothing.

When CI is green for a push to `main`, `.github/workflows/release.yml` runs `nx release version`, which versions the packages, commits `chore(release): publish <version>`, tags `release/<version>` and pushes both, and then `nx release publish`, which publishes to npm. Nothing reaches npm unless `main` has its release commit and tag, and a version already on npm is skipped. A push with nothing to release changes nothing. The release runs only for the commit CI tested; when `main` has moved on, the newer commit's CI run releases it.

To see what the next release would be:

```sh
npx nx release version --dry-run
```
