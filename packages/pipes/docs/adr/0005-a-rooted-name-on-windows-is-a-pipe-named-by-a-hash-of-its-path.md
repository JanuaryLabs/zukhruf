# A rooted name on Windows is a pipe named by a hash of its path

On Windows, `node:net` listens on a named pipe: a path under `\\.\pipe\` or `\\?\pipe\` (Node `net.md`, "Identifying paths for IPC connections"). Pipe names are one namespace for the computer, not files in a folder. .NET maps a pipe name to `\\.\pipe\<name>` (`NamedPipeServerStream.Windows.cs:94`). It has no rule for a rooted name on Windows.

mutex and single-flight need one: their programs meet at one folder, and each program must find the same pipe from that folder. Both copies make the pipe name from the first 32 hex digits of the SHA-256 of the resolved folder in lower case, because Windows paths ignore case (`socketPathFor` in `mutex/src/lock-stores/socket/socket-store.ts`, `single-flight/src/connection/socket-path.ts`). A plain name of sqlite-notify is already unique: it is random.

## Decision

- A plain name is the pipe `\\.\pipe\<prefix>-<name>`.
- A rooted name is the pipe `\\.\pipe\<prefix>-<id>`. `<id>` is the first 32 hex digits of the SHA-256 of `path.win32.resolve(name).toLowerCase()`.
- The hash takes the whole rooted name, with its file name, not only its folder. So `lock.sock` and `flight.sock` in one folder are two pipes, as they are two files on Unix.
- The prefix starts each pipe name, so `Get-ChildItem \\.\pipe\` shows which package made it.

## Considered Options

- **The rooted name in the pipe name as it is.** A pipe name can have any character but `\` (Windows docs of `CreateNamedPipe`, not read in research 21), and a path has `\`.
- **A hash of the folder only, as the copies.** Then two endpoints in one folder need two prefixes to differ. On Unix they differ by their file name, and the rule should be the same.
- **A hash of the whole lowercased path.** This option was selected.

## Consequences

- The pipe names of mutex and single-flight change from `mutex-<hash>` and `single-flight-<hash>`. A program of an older release does not meet a program of a newer one on Windows.
- Two paths that differ only in case are one pipe on Windows, as they are one file there.
- Windows is not proven. Its proof is backlog #4340, and nothing waits for it.
