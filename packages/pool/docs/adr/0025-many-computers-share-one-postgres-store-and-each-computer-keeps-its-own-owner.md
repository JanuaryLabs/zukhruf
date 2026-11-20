# Many computers share one Postgres store, and each computer keeps its own owner

Status: Accepted 2026-11-20 (backlog #3527). Not built. Built only when a second computer is real (map, Revision 2026-11-13). Map ticket 14 is open.

The destination of the map covers both scopes: one computer, and many computers (Ezz, 2026-11-03). The first build is one computer. This ADR records what the map decided for many computers, and what it did not.

Across computers the leading systems put a queue between the computers and one owner inside each: a broker or a database that every node reads, and the cap of one node in the program on that node (map tickets 04 and 06).

## Decision

From map tickets 03, 04, 05, 06, 08, 11 and 13:

- **One setting joins the computers**: `store: 'postgres://…'`. The pool builds a pg-boss store from it. This is configuration, not other host code (map ticket 04, Ezz: "Yes"). The address names the store, as the path of a file does on one computer ([ADR 0015](./0015-the-store-is-a-required-input-and-computer-store-gives-the-store-of-the-computer.md)).
- **Each computer elects its own owner** with the lock file of that computer. Each owner caps its own computer with its own sizing ([ADR 0016](./0016-the-owners-sizing-caps-the-jobs-of-its-computer.md)). The store keeps no cap across computers.
- **News travels through Postgres `LISTEN` / `NOTIFY`** on the same database, on the two channels of each pool, with pg-boss's backstop rule `max(30 s, pollingInterval)` ([ADR 0018](./0018-news-travels-by-push-through-the-notify-of-the-store-with-a-backstop.md)).
- **A hung or dead owner** on one computer is ended by the election of that computer. Its jobs come back to the store by their heartbeat, and the owner of any computer can take them ([ADR 0024](./0024-a-hung-owner-is-ended-by-the-election-and-its-late-acts-are-fenced.md)).
- **A file goes by its hash.** One computer keeps `{ path }`, best as `{ path, sha256 }`. Many computers send `{ sha256 }`, and the bytes go once to an S3-compatible store before the job is sent (the Claim Check pattern of Enterprise Integration Patterns and the Azure Architecture Center; the SQS Extended Client). No network file system: nfs(5), flock(2) and SQLite document unreliable locks across clients, and `@zukhruf/fs` throws `NetworkDirectoryError` (map ticket 03, research 03).

## Not specified yet

Each item waits for a second computer:

- **Map ticket 14**: who moves a file to the shared store (the pool with a claim check built in, as the SQS Extended Client does, or the worker kind or the host), how an input marks a file, where the bytes live (inside the Postgres store, or behind a second setting for an S3-compatible server; MinIO's community repository is archived), and who deletes an uploaded file and when.
- **The folder of the election** when the store is a Postgres address. On one computer it is the folder of the store file. `computerStore(env)` gives one store only.
- **The `NOTIFY` in the transaction** of pg-boss's `send` and `complete`, and what a lost connection does.
- **The caller's address across computers**. A pipe of one computer cannot be reached from another ([ADR 0021](./0021-a-caller-whose-host-is-gone-cancels-its-jobs-and-the-owner-learns-it-from-a-closed-connection.md)).
- **The backstop interval**, measured on a real Postgres.

## Consequences

- The code of a host does not change when its computer joins others.
- A computer that cannot run the worker program sends jobs that an owner on another computer runs.
- A cap across all computers, for example the rate limit of a paid API, stays out of scope.
