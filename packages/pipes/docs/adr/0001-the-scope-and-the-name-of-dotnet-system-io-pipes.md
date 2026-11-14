# The scope and the name of .NET's System.IO.Pipes

`@zukhruf/mutex` and `@zukhruf/single-flight` each have a copy of `socketPathFor`: a socket file of at most 103 bytes in a folder, or a named pipe on Windows (`mutex/src/lock-stores/socket/socket-store.ts`, `single-flight/src/connection/socket-path.ts`). `@zukhruf/sqlite-notify` needs the same knowledge. That is the third place, so the code moves into one package before the third copy exists (sqlite-notify ADR 0008).

The libraries that do this work give different scopes (research 21 §4):

- .NET `System.IO.Pipes` is the one API whose one name works on both systems: a Win32 named pipe on Windows, and a Unix socket elsewhere. It maps a name to an endpoint, checks the byte length, removes a leftover file before it binds, removes the file at the last dispose, has a per-user option (`PipeOptions.CurrentUserOnly`), and gives a server and a client.
- Go's `net` gives `"unix"` on each system and no named pipes. go-winio gives the pipes. Docker's `go-connections/sockets` joins them only for HTTP transports. Each takes the full path from the caller.
- libuv, under `node:net`, calls both kinds a pipe (`uv_pipe_t`).

## Decision

Ezz chose the name and the scope on 2026-11-14.

- The package is `@zukhruf/pipes`, after `System.IO.Pipes`. It is public.
- Its scope is .NET's: a name to an endpoint, the byte-length check, the leftover file removed at listen, the removal at close, the per-user rule, listen and connect. Each gives the objects of `node:net`.
- The name rule is .NET's: a rooted name is the full path of the socket, and any other name goes into the default folder (`PipeStream.Unix.cs:203-209`).
- One difference from .NET: the per-user rule. On Unix, .NET reads the peer's user id after each connect and each accept (`GetPeerID`, `NamedPipeServerStream.Unix.cs:107-119`). `node:net` has no call for the peer's credentials: on Node 26.13.0 a socket has only `_getpeername`. So here the rule comes from a folder of this user with mode `0700`, checked as tmux checks `/tmp/tmux-<uid>` ([ADR 0002](./0002-the-default-folder-belongs-to-one-user.md)).
- The names of the calls: `PipeEndpoint` after .NET's `UnixDomainSocketEndPoint`, which owns the length check. Its methods `listen` and `connect` have Node's verbs, and `listen` gives a `PipeServer` ([ADR 0007](./0007-the-endpoint-listens-the-address-connects-and-the-server-owns-its-file.md)).

## Considered Options

- **A helper for the path only, as Docker's and containerd's.** The three consumers also share the folder, the removal at listen and the wait for `listening`. A path helper leaves each of them with its own copy of those.
- **Go's scope: the caller gives the full path.** Then each consumer keeps its own folder rule and its own Windows name.
- **.NET's scope, with the per-user rule from a folder.** This option was selected.

## Consequences

- One place holds the socket path, the default folder, the pipe name and the limit.
- On Unix, a program of another user that can reach the socket is not refused by the package. It is refused by the mode of the socket and of the folder (research 20a P5). On Windows, the package has no per-user rule that `node:net` can give. It is in the README's "Open" list.
