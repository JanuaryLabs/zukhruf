# The socket address is the third place, so its extraction comes first

The Rule of Three counts places that hold the same knowledge. The third place extracts it, and the size of the work is never a reason against it (Ezz, 2026-11-13). Backlog #2496 holds the transport code that `@zukhruf/mutex` and `@zukhruf/single-flight` copy, and waits for a third consumer. Its ledger is `packages/single-flight/docs/copied-from-mutex.md`.

This package needs a socket on macOS and Linux and a named pipe on Windows. The count, for each part of #2496 and of the ledger:

| Knowledge                                                                                                    | Places today                                                                                                                  | This package                                                                               | Count |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----- |
| The socket address: a socket file of at most 103 bytes or a `RangeError`, and a named pipe under `\\.\pipe\` | `mutex/src/lock-stores/socket/socket-store.ts:114-124` (`socketPathFor`), `single-flight/src/connection/socket-path.ts:12-24` | Needs it: a socket file in the socket folder, a pipe on Windows                            | **3** |
| JSON lines on a stream socket (`socket-connection.ts`, `json-line.ts`)                                       | mutex, single-flight                                                                                                          | Not needed: a wake is one byte with no content                                             | 2     |
| The handshake and its protocol version                                                                       | mutex, single-flight                                                                                                          | Not needed: the wake has no content, and the tables are the contract between versions      | 2     |
| The connection supervisor, which connects again after a loss                                                 | mutex, single-flight                                                                                                          | Not the same knowledge: a sender removes a lost listener, it does not connect again        | 2     |
| The electing connector and the server shell (remove the old file, listen, `unref`, close at a lost term)     | mutex, single-flight                                                                                                          | Not needed: no election ([ADR 0003](./0003-no-hub-each-listener-serves-its-own-socket.md)) | 2     |
| The removal of a stale socket file                                                                           | mutex and single-flight remove it before they listen, because the election proves that no server runs                         | A sender removes it after a refused connect. Another reason, so not the same knowledge     | 1     |
| The socket folder of one user, with tmux's checks                                                            | none                                                                                                                          | New ([ADR 0007](./0007-the-socket-folder-is-short-and-belongs-to-one-user.md))             | 1     |

## Decision

The socket address is the third place. Its extraction comes first, as the socket-path part of #2496, before this package has code.

- The boundary comes from the three copies. The same in each: the 103-byte limit and its `RangeError`, and the `\\.\pipe\` namespace on Windows. Different, so parameters: the folder, the file name, and the pipe name. mutex and single-flight make the pipe name from a hash of the lowercased folder, because their programs meet at one folder. This package makes it from a random listener id, because each listener has its own.
- The limit is checked again against research 20a P3 (104 bytes on macOS, 108 on Linux), as the ledger asks.
- mutex and single-flight switch to the extracted code, their copies go, and the ledger records it.
- The rest of #2496 stays at two places. This package does not use it, and the rule moves only the extracted code and what it depends on.

## Considered Options

- **A third copy of `socketPathFor` in this package.** The Rule of Three forbids it.
- **Wait for a consumer of the whole transport.** The socket address has its third place now.
- **Extract the socket address first.** This option was selected.

## Consequences

- This package's code waits for that extraction.
- The home of the extracted code is not decided: the coordinator package that #2496 names, or another. It is in the README's "Open" list.
- A fix to the socket address goes into one place.
- JSON lines, the handshake, the supervisor and the server shell keep their two copies, and #2496 keeps waiting for their third place.
