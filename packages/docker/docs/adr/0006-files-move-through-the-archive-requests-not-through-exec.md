# Files move through the archive requests, not through exec

The repositories move files in and out of containers through exec, as base64 text:

- The sandbox of `@deepagents/context` writes files as base64 in the arguments of `exec`, in parts of 32 KB, because of the limit on the length of arguments (`cli-process.ts:83`). It reads files and checks paths with more commands.
- The volume adapter of text2sql writes files as base64 on the standard input of `exec -i`, and reads them as base64 on standard output (`volume-adapter.ts:94-213`). A task to stream binary output in place of base64 is open (text2sql `docs/plans/2026-07-15-files-sdk-tasks.md:77`, FS-224).
- serverize sends a tar archive with `putArchive` of dockerode (`packages/docker/src/lib/npm.ts`).

Base64 through exec needs a running container, a shell, and `base64` in the image. Each file costs a process in the container.

The Engine API has three requests for files ([`/containers/{id}/archive`](https://docs.docker.com/reference/api/engine/)):

- `HEAD` gives the metadata of a path in the header `X-Docker-Container-Path-Stat`, or 404.
- `GET` gives a tar archive of a path.
- `PUT` extracts a tar archive into a directory. The reference gives 403 for a read-only root filesystem or volume, but Moby checks only the directory of the extraction, and it answers 400 (`checkWritablePath` in [`daemon/archive_unix.go`](https://github.com/moby/moby/blob/master/daemon/archive_unix.go)).

`docker cp` uses these requests. Its documentation says that the container "can be a running or stopped container". It also gives their limits: they cannot reach `/proc`, `/sys`, `/dev`, a tmpfs mount, or "mounts created by the user in the container" ([docker container cp](https://docs.docker.com/reference/cli/docker/container/cp/)). For a tmpfs, the engine reads the directory under the mount ([moby#22020](https://github.com/moby/moby/issues/22020)). Testcontainers for Node.js copies files into a container with `putArchive` ([testcontainers-node#1488](https://github.com/testcontainers/testcontainers-node/pull/1488)). It gives files back only as a tar stream, so a test that reads one file must parse tar ([testcontainers-node#1547](https://github.com/testcontainers/testcontainers-node/issues/1547)). microsandbox gives `fs()` with `read`, `write`, `stat` and `exists`.

## Considered Options

- **Exec with base64**, as the repositories do now. It needs a shell and `base64` in the image, and a running container.
- **Exec with binary standard input and output.** It needs no base64, but it still needs a running container and a program such as `cat` in the image.
- **The archive requests.** This option was selected.

## Consequences

- `container.stat(path)` gives the metadata of a path, or `undefined` when the path is missing. A 404 of these requests can also mean a missing container ("Container or path does not exist"), so the package inspects the container after a 404 ([ADR 0007](./0007-an-error-has-its-own-class-when-the-caller-handles-it-differently.md)). `container.readFile(path)` gives the bytes of one regular file. `container.writeFiles(files)` writes files and directories in one request. These work on a stopped container and on an image with no shell.
- `container.getArchive(path)` and `container.putArchive(directory, archive)` give the tar streams themselves, for a directory or a large tree.
- The package writes and reads tar itself, because Node.js has no tar module. `writeFiles()` writes one archive and extracts it in the deepest directory that holds each entry and that already exists. Thus a read-only root filesystem does not refuse files for a writable volume, and a file can go into a directory that does not exist yet: the engine creates each parent directory that an entry implies (`createImpliedDirectories` in [moby/go-archive](https://github.com/moby/go-archive/blob/main/archive.go)). The reader accepts the PAX headers that the engine writes for long names.
- The engine keeps the owner that the archive gives each entry. With `copyUIDGID=1`, it gives each entry to the user of the container (`Config.User`) instead (`applyTarCopyUserOptions` in [`daemon/archive_tarcopyoptions_unix.go`](https://github.com/moby/moby/blob/master/daemon/archive_tarcopyoptions_unix.go)). Thus `writeFiles()` writes the `uid` and `gid` of each entry, or 0 and 0, into the archive, and never sends `copyUIDGID`. `putArchive()` sends it only when the caller asks.
- A path under `/proc`, `/sys`, `/dev`, a tmpfs mount, or a mount made inside the container is out of reach. Use `exec()` for such a path.
- The base64 code of `@deepagents/context` (backlog #2760) and of the text2sql volume adapter (backlog #2757) goes away when they change to these requests.
