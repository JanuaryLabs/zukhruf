# A connect that finds no server rejects with NoServerError

Status: Accepted 2026-11-23 (#5317). Ezz chose "Go: NoServerError in pipes" for the question: "five zukhruf places each list which connect errors mean 'no server listens', and four of them lack ECONNRESET. I propose @zukhruf/pipes' address.connect() rejects with a new NoServerError (ENOENT, ECONNREFUSED, ECONNRESET during the connect, ENOTSOCK), while EAGAIN and EACCES stay Node's error."

[ADR 0006](./0006-connect-tries-once.md) left the meaning of a failed connect to each consumer. Five places then listed the codes that mean "no server" in five ways:

| Place                                                          | Codes                                           |
| -------------------------------------------------------------- | ----------------------------------------------- |
| `election/src/sqlite/leader-reader.ts`                         | `ENOENT`, `ECONNREFUSED`, `EACCES`              |
| `mutex/src/lock-stores/socket/electing-connector.ts` (`reach`) | `ENOENT`, `ECONNREFUSED`, `ENOTSOCK`, `EAGAIN`  |
| `single-flight/src/connection/electing-connector.ts` (a copy)  | the same as mutex                               |
| `sqlite/notify/src/wakes.ts`                                   | `ECONNREFUSED`, `ENOENT`                        |
| `pool/src/pool-workers.ts`                                     | `ECONNREFUSED`, `ENOENT`, `ECONNRESET`, `EPIPE` |

Only pool had `ECONNRESET`. On Linux, a connect completes in the kernel at once, and libuv reads its result (`SO_ERROR`) one turn of its loop later. A server that closes in between, before it accepts the connection, resets it: the kernel sets `ECONNRESET` on the client (`af_unix.c`, `unix_release_sock`), and the connect fails with it. macOS connects, and then the client gets `end`. A probe gave each result 20 times of 20 (`node:26-alpine` and `node:lts-bookworm-slim` with 4 CPUs, and macOS). So on Linux, a standby that connected while its owner closed its pipe failed its campaign: `connect ECONNRESET` failed pool's test "a standby starts no worker…" in CI run 45026887495 (#5317).

A second probe filled the listen queue of a live server that accepts nothing. macOS refused the connect after 128 connections (`kern.ipc.somaxconn`) with `ECONNREFUSED`, the code of a leftover file. Linux gave `EAGAIN` after 512 connections.

## Decision

`address.connect` rejects with `NoServerError` when the kernel says that no server accepts the connection on the path:

- `ENOENT`: nothing is at the path.
- `ECONNREFUSED`: a socket file with no server, such as the file that a crashed server left.
- `ENOTSOCK`: macOS, a file that is not a socket.
- `ECONNRESET` before the connect completes: Linux, the server closed before it accepted the connection.

Its `cause` is the error of Node.js, and its `path` is the path of the address. Each other failure rejects with the error of Node.js: `EAGAIN` (Linux, the listen queue of a server is full), `EACCES` (another user's socket), and `ABORT_ERR`. On macOS, a server whose listen queue is full also refuses a connect, so there `NoServerError` can come from a live server that accepts nothing now (#5424).

What a consumer does next stays its rule, as ADR 0006 says. The election reads `'absent'`, also for `EACCES` (election ADR 0007). The connectors of mutex and single-flight reach again, also after `EAGAIN`. sqlite-notify marks the listener dead. Pool cancels the job of a caller that is gone.

The name is ours, from the word "server" of [CONTEXT.md](../../CONTEXT.md). No industry name for this group of codes was found.

## Considered Options

- **Each consumer keeps its own codes (ADR 0006).** The five lists differed, and four had no `ECONNRESET`.
- **A predicate `isNoServer(error)` over the error of Node.js.** A caller then needs the predicate and `isErrno` side by side, and the error does not name the path.
- **An error class.** Catching it changes the next step of the caller, as `UnsafeFolderError` of this package and `NetworkDirectoryError` of `@zukhruf/fs` do. Go groups platform codes in the same way: `errors.Is(err, fs.ErrNotExist)` matches `ENOENT`. This option was selected.
- **`EAGAIN` in `NoServerError` too.** A server is there. sqlite-notify and pool would then destroy the state of a live peer on Linux.

## Consequences

- election, mutex, single-flight, sqlite-notify and pool check `NoServerError` in place of the codes. Pool keeps `ECONNRESET` and `EPIPE` only for a connection that broke after the connect.
- A caller that read `code` from a failed connect reads `error.cause.code`.
- ADR 0006 is superseded in part for its last consequence.
- Open: on macOS, sqlite-notify and pool destroy state after a refusal that a full listen queue can also give (#5424). The election rejects on `EAGAIN` (#5425).
