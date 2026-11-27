# The package is in the base layer

Status: Accepted 2026-11-28 (backlog #6201).

Decision-makers: the zukhruf session mutex-d0, from root ADR 0001.

Root ADR 0001: "A base package imports Node.js, other base packages and npm packages, and never a package of another layer", and "The layer of a package follows what it imports". A new package gets its layer tag before its first import of another package.

This package imports:

| Import                        | For                                  | Its tags                   |
| ----------------------------- | ------------------------------------ | -------------------------- |
| `@zukhruf/fencing`            | `FencingToken`, the epoch of a claim | `std:base`, `layer:island` |
| `@zukhruf/sqlite-transaction` | the transaction of the SQLite store  | `std:base`, `layer:island` |
| `@zukhruf/sqlite-drift`       | the tables of the SQLite store       | `std:base`, `layer:island` |
| `node:sqlite`                 | the SQLite store                     | Node.js                    |

The Postgres and SQL Server stores take a session that the host writes, so they import no driver ([ADR 0011](./0011-the-package-has-a-memory-store-and-stores-for-sqlite-postgres-and-sql-server-and-a-host-can-write-its-own.md)). The package has no clock, because it never waits ([ADR 0008](./0008-a-newer-claim-fences-an-older-one-and-a-commit-of-a-fenced-claim-throws-and-writes-nothing.md); root ADR 0004 applies to a library that waits).

## Decision

1. `@zukhruf/checkpoint` is a package of the base layer, with the tags `std:base` and `layer:island`.
2. It imports no package of the coordination or domain layers. It does not import `@zukhruf/mutex`: the epoch of a claim fences the older owner, and the package holds no lock.
3. The base row of root ADR 0001 gets `checkpoint`.

## Considered Options

- **The domain layer, with `@zukhruf/mutex` for a lock of each partition.** A lock refuses the newer run and goes away silently with its connection (#2409, #5301). The epoch needs no lock.
- **The base layer.** This option was selected.

## Consequences

- Base packages, such as `@zukhruf/sqlite-changefeed`, can import this package.

## Confirmation

- `project.json` tags of `@zukhruf/fencing`, `@zukhruf/sqlite-transaction` and `@zukhruf/sqlite-drift`, read on 2026-11-27: `["layer:island", "std:base"]`.
- Root ADR 0001, line 11: the base row lists `fencing`, `sqlite-drift`, `sqlite-transaction` and `sqlite-changefeed`.
