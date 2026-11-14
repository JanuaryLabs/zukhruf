# Listen removes the file at the path, and close removes it again

A socket file stays after its server crashes. A connect to it gives `ECONNREFUSED`, and a listen on its path gives `EADDRINUSE` (research 20a P1; probe, 2026-11-14, Node 26.13.0, `~/.claude/scratch/pipes-paper/probe.mjs`). Something must remove it before the next server can listen.

The precedent splits (research 21 §1, §2):

- .NET's pipe server removes whatever is at the path before it binds, and ignores a failure: "Binding to an existing path fails, so we need to remove anything left over at this location" (`NamedPipeServerStream.Unix.cs:311-318`). Docker's `NewUnixSocketWithOpts` and containerd's `CreateUnixSocket` do the same. None of them connects first to test the file. Each assumes one server per path.
- Go's `net.Listen` removes nothing, so the bind fails.

At close:

- .NET removes the file at the last dispose, Go's listener at `Close` by default, and Node at `server.close()` (Node `net.md`; probe of the sqlite-notify paper, `~/.claude/scratch/sqlite-notify-paper/close-unlinks.mjs`).
- Node removes the file by its path, not by its inode. A server A listened, its file was removed, a server B listened on the same path, and then A closed: B's file was gone, and a connect gave `ENOENT` (probe, 2026-11-14).

The three consumers each prove that one server runs on a path. mutex and single-flight listen only after their election wins, and remove the file today with `rm(socketPath, { force: true })` before `listen` (`lock-server.ts`, `flight-server.ts`). sqlite-notify gives each listener a random name, so a leftover file never has the name of a new listener.

## Decision

- On macOS and Linux, `listenPipe` removes the file at the socket path before it listens, without a check, as .NET does. A missing file is no error. A folder at the path is an error.
- On Windows it removes nothing. Windows removes a pipe when its program exits.
- `listenPipe` adds nothing to the close: `server.close()` removes the file, as Node does.
- The README states the rule for the caller: one server listens on a path at a time, and a server that lost its right to the path closes before the next server listens.

## Considered Options

- **Fail the bind, as Go.** Each of the three consumers would then remove the file itself, and the knowledge would stay in three places.
- **Connect first, and remove the file only after `ECONNREFUSED`.** No library of research 21 does it. Two servers can both see the refusal and both remove: the second removes the first one's new file. So it does not replace the proof of one server, and with the proof it adds nothing.
- **An option to keep the file, as .NET's `PipeOptions.FirstPipeInstance`.** No consumer needs it.
- **Remove the file without a check, as .NET.** This option was selected.

## Consequences

- A caller that runs two servers on one path breaks the first one: its clients can no longer reach it. The README says so.
- The close of a server that lost its term can remove its successor's file. mutex and single-flight end the term only after the close (`flight-server.ts`), and keep that order.
