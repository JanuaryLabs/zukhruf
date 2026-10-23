# Each family of lock stores has its own import path

The package had one entry point, `@zukhruf/mutex`. It gave the core (`Mutex`, `Key`, the acquire modes, `LockStore`, `leaseFor` and `LeaseLostError`) and each lock store. Thus a process that imports `MemoryStore` also loads the socket lock store and its election, and the file lock stores. Lock stores with a larger reach come next, for example a lock store on a Postgres database or on a Docker engine. Each of them needs a client. On the one entry point, each user would load each client.

Thus each family of lock stores has its own import path, and the root gives only the core. A family is a folder in `src/lock-stores` with an `index.ts`. The folder name is the import path:

| Import path                  | Gives                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `@zukhruf/mutex`             | `Mutex`, `Key`, the acquire modes, `LockStore`, `LockHandle`, `leaseFor`, `LeaseLostError` |
| `@zukhruf/mutex/memory`      | `MemoryStore`                                                                              |
| `@zukhruf/mutex/thread`      | `ThreadStore`, `ThreadLockCoordinator`                                                     |
| `@zukhruf/mutex/ipc`         | `IpcStore`, `IpcLockCoordinator`                                                           |
| `@zukhruf/mutex/file-system` | `TicketQueueFileStore`, `LockFileStore`, `FileLockStore`                                   |
| `@zukhruf/mutex/sqlite`      | `SqliteStore`                                                                              |
| `@zukhruf/mutex/socket`      | `SocketStore`                                                                              |

Each import path also gives the errors that its lock stores throw. An error that more than one family throws, for example `CoordinatorUnavailableError`, is one class on each path. Thus a catch with `instanceof` works with the class from each path.

`package.json` maps the paths with one Node.js subpath pattern: `"./*"` maps to `./dist/lock-stores/*/index.js`. Node.js puts the same text in the place of each `*`. The folder `remote` keeps the code that the thread, IPC and socket lock stores share. It is not a family, so it has no `index.ts`, and `"./remote": null` removes its path.

## Considered Options

- **One entry point.** This was the behavior up to 0.3.39. Each user loads each lock store, and later each client of each lock store.
- **An import path only for a lock store that needs another package.** Two rules would then decide where a lock store is. `@zukhruf/testing` gives each of its areas an import path ([its ADR 0002](../../../testing/docs/adr/0002-each-area-has-its-own-import-path.md)). One rule for each family is the same as that ADR.
- **An entry in `package.json` for each family, written by hand or by a generator.** The pattern does the same with no entry for each family. A new family is a folder with an `index.ts`, and nothing more.
- **A package for each lock store.** It is more to version and to release, for lock stores that share the core and the `remote` code. The `@zukhruf/testing` ADR 0002 refused this option for the same reason.

## Consequences

- An import of a lock store from the root fails. A consumer must change each import of a lock store to the path of its family. This change has no compatibility path.
- The dependencies of the package stay the same for each family. For example, `@zukhruf/election` is a dependency of the package, but only the socket lock store loads it. An install does not get smaller. A process loads less.
- A new family needs a folder with an `index.ts`. Then its import path exists. `src/import-paths.test.ts` lists each family and what it gives, so add the new family there.
- The README table "Select a lock store" and each page in `docs/stores` show the import path of the family.
- A test in another process imports a lock store from the `index.ts` of its family. A test of the latest release imports it from the root of that release, because that release gives its lock stores at the root.
