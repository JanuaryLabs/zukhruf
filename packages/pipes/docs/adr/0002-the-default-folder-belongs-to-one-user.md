# The default folder belongs to one user

A plain name goes into the default folder. .NET's default folder is `Path.GetTempPath()`, which is `$TMPDIR` on Unix, and it puts the file there as `CoreFxPipe_<name>` (`PipeStream.Unix.cs:33`, `Path.Unix.cs:81-93`). Four facts bound the choice here:

- The socket path takes at most 103 bytes on macOS ([ADR 0004](./0004-the-socket-path-is-at-most-one-byte-less-than-sun-path.md)).
- `os.tmpdir()` on macOS is a folder under `/var/folders/`. On the computer of this paper it is `/var/folders/gd/q0ppqddd6v34xxqmbnfwb8hm0000gn/T`: 48 bytes (measured with Node 26.13.0, 2026-11-14). The path of `@zukhruf/sqlite-notify` there would be 48 + `/zukhruf-sqlite-notify-501/` (27) + a name of 32 hex digits = 107 bytes. That is over the limit. `TMPDIR` can be longer still.
- `/tmp` on Linux is shared by every user. .NET's files there are safe only because .NET checks the peer's user id on each connection. `node:net` cannot read it ([ADR 0001](./0001-the-scope-and-the-name-of-dotnet-system-io-pipes.md)). Another user can also make a folder in `/tmp` before this user does.
- tmux makes `/tmp/tmux-<uid>` with mode `0700`. It refuses the folder when `lstat` says it is not a folder, when its owner is another user, or when others have any access (`tmux.c:209-229`, tag 3.5a). `@zukhruf/sqlite-notify` chose the same folder for the same reasons (its ADR 0007).

## Decision

- On macOS and Linux, the default folder is `/tmp/<prefix>-<uid>`. `<prefix>` is the caller's, and `<uid>` is `process.getuid()`. The file of a plain name is `<name>` in it, with no suffix, as .NET's and tmux's files have none.
- `endpoint.listen` makes the folder with mode `0700` when it is missing, and then reads it with `lstat`, also after it made it, as tmux does. It throws `UnsafeFolderError` when the folder is not a folder, when its owner is another user, or when its group or others have any access. tmux checks only the others. The group is checked too, because the package makes the folder with no group access, so a group bit means that someone changed it.
- This folder is the per-user rule of the package: .NET's `CurrentUserOnly` for each plain name. There is no option for it. A plain name is always for this user. A rooted name is in the caller's folder, and its access is the caller's.
- The caller gives a prefix in place of .NET's fixed `CoreFxPipe_`. Two consumers with two prefixes never share a folder.
- `address.connect` does not check the folder. Its address may come from a path that the client read from another place, with `new PipeAddress(path)` ([ADR 0006](./0006-connect-tries-once.md)).

## Considered Options

- **`os.tmpdir()`, as .NET.** It spends 48 of the 103 bytes on macOS, and a long `TMPDIR` makes each listen fail.
- **`XDG_RUNTIME_DIR`.** Linux only, and not set in every session, for example in a container.
- **A `currentUserOnly` option, as .NET.** On Unix .NET's option is a check of the peer, which `node:net` cannot do. A folder check under an option would give a plain name a second, shared default folder, which no consumer needs.
- **`/tmp/<prefix>-<uid>` with tmux's checks.** This option was selected.

## Consequences

- The path of a plain name is short on each system: `/tmp/zukhruf-sqlite-notify-501/` and a name of 32 hex digits is 63 bytes.
- A program of another user cannot plant the folder, and cannot connect to a socket in it (research 20a P5).
- A sandbox that forbids `/tmp` cannot listen on a plain name. It can listen on a rooted name in a folder that it can write.
