# The socket folder is short and belongs to one user

Each listener serves its own socket ([ADR 0003](./0003-no-hub-each-listener-serves-its-own-socket.md)), so each needs an address that no other listener has. Four facts bound the choice:

- A Unix socket path takes at most 104 bytes on macOS and 108 on Linux; one more byte fails with `EINVAL` (research 20a P3). zukhruf keeps 103 (`packages/single-flight/src/connection/socket-path.ts`).
- `os.tmpdir()` on macOS is a folder under `/var/folders/`, about 49 bytes, and `TMPDIR` can be any length.
- `/tmp` is shared by every user. Another user cannot connect to a socket with Node's default mode `0755` (research 20a P5), but another user can make a folder in `/tmp` before this user does.
- A socket file stays after its server crashes (Node `net.md`; research 20a P1).

Two mature programs put sockets in `/tmp`. Postgres's default `unix_socket_directories` is `/tmp`. tmux makes `/tmp/tmux-<uid>` with mode `0700`, and refuses it when it is not a folder, when its owner is another user, or when others have access (`tmux.c:209-229`, tag 3.5a; `TMUX_SOCK` is `$TMUX_TMPDIR` or `_PATH_TMP` in `tmux.h:84-85`).

## Decision

- On macOS and Linux, the socket folder is `/tmp/zukhruf-sqlite-notify-<uid>`, with `<uid>` from `process.getuid()`. The package makes it with mode `0700`. When it exists, the package reads it with `lstat`, and refuses it with `SocketFolderError` when it is not a folder, when its owner is another user, or when its group or others have access. This is tmux's rule, also for the group.
- A listener's socket is `<listener id>.sock` in that folder. The listener id is 16 random bytes in hex. The path is at most about 75 bytes.
- On Windows, the socket is the named pipe `\\.\pipe\zukhruf-sqlite-notify-<listener id>`. Pipe names are one namespace for the computer, and the random id keeps them apart. Windows removes a pipe when its program exits. By the Windows docs, the default security of a pipe gives other users read access only [inference, not run]. The proof is backlog #4340, and nothing waits for it.
- Programs do not need to agree on the folder: each listener writes its full address in the file, and a sender connects to the address it read.
- The sender that finds an address dead removes its socket file. A listener's clean close removes its own file, because Node removes a Unix socket file when its server closes.

## Considered Options

- **`os.tmpdir()`.** On macOS it spends about 49 of the 103 bytes, and a long `TMPDIR` makes every listen fail.
- **`XDG_RUNTIME_DIR`.** Linux only, and not set in every session, for example in a container.
- **A folder beside the database file.** Its path has any length, and a folder on a network disk cannot hold a socket.
- **The address in a folder that the caller gives.** No caller needs another folder, and a test gets a new address from the random id.
- **`/tmp/zukhruf-sqlite-notify-<uid>`, with tmux's checks.** This option was selected.

## Consequences

- The socket path is short on each system, whatever the path of the database.
- A program of another user cannot connect, and cannot plant the folder. Pools are per user.
- A socket file with no row is left when a listener is killed between its listen and its registration. Nobody removes it. It is in the README's "Open" list.
- A sandbox that forbids `/tmp` cannot listen. It can still send.
