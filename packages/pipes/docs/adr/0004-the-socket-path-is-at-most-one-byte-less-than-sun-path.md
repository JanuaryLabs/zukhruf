# The socket path is at most one byte less than sun_path

A socket path must fit in `sun_path`. The measures and the precedent:

- `node:net` takes at most 104 bytes on macOS and 108 on Linux, and gives `EINVAL` one byte later, for `listen` and for `connect`. The limit is in bytes, not characters (research 20a P3).
- It counts the path as it is given, not the resolved path (research 20h §2).
- Node 26.10.0 took longer paths on macOS. Node 26.13.0 and 24.22.2 stop at 104 (research 20h §2). So the limit of Node can change between releases.
- .NET counts the UTF-8 bytes and the ending zero byte, so its longest path is 103 bytes on macOS and 107 on Linux; above it, `UnixDomainSocketEndPoint` throws `ArgumentOutOfRangeException` (`UnixDomainSocketEndPoint.cs:36-51`). Go's `syscall` gives `EINVAL` above the same 103 and 107 bytes (`syscall_bsd.go:188-193`, `syscall_linux.go:547-561`). Node's docs give the same numbers (`net.md`).
- zukhruf's two copies keep 103 bytes on each system, and throw a `RangeError`.

## Decision

- The longest socket path is 103 bytes on macOS and every other system that is not Linux or Windows, and 107 bytes on Linux. These are .NET's and Go's limits: one byte less than `sun_path`, for the ending zero byte.
- `new PipeEndpoint` counts the UTF-8 bytes of the path as it is given, before any file is made.
- A longer path is a `RangeError`, as in both copies, and as .NET's `ArgumentOutOfRangeException`. Its message: `The socket path <path> is <n> bytes, more than <limit>; choose a shorter folder or name.`
- Windows has no `sun_path`. The package does not check the length of a pipe name.

## Considered Options

- **103 bytes on each system, as the copies.** A path that works on Linux then works on macOS too. But .NET and Go give each system its own limit, and so do Node's docs.
- **Node's measured limit, 104 and 108.** It is one byte over what .NET and Go allow, and Node 26.10.0 shows that it can move.
- **No check, as Go `net`, which leaves it to `EINVAL`.** The error then comes at listen, not when the path is made, and `EINVAL` does not name the path.
- **One byte less than `sun_path` on each system.** This option was selected.

## Consequences

- A path of 104 to 107 bytes works on Linux and fails on macOS. A consumer that ships to both keeps its paths at 103 bytes. A plain name in the default folder is far under it ([ADR 0002](./0002-the-default-folder-belongs-to-one-user.md)).
- `RangeError` is no class of this package. A caller of a path that is too long changes its folder or its name: no catch changes its next step.
