# Output framing follows the TTY setting, as the Docker CLI chooses it

The output of an attach, an exec and the logs comes in one of two forms. A process without a TTY gives a multiplexed stream: frames with an 8-byte header that marks standard output or standard error. A process with a TTY gives a raw stream with no frames ([ADR 0005](./0005-output-is-one-stream-of-chunks-and-only-a-close-ends-the-input.md)).

Before this decision, the package chose the form from the Content-Type of the answer. It read frames only when the Content-Type was `application/vnd.docker.multiplexed-stream`, and it read a raw stream for each other value, or for none.

Docker Desktop sends that Content-Type. socktainer, an Engine API server on top of Apple's `container` tool, does not. It answers an exec start with `HTTP/1.1 101 Switching Protocols`, `Connection: Upgrade` and `Upgrade: tcp`, and with no Content-Type. Its output is still multiplexed. A probe on 2026-11-15 ran `sh -c "echo out; echo err >&2"` through socktainer. The package gave `stdout="\u0001\u0000\u0000\u0000\u0000\u0000\u0000\nhello-exec"` and an empty `stderr`: the frame headers leaked into standard output.

The Docker CLI does not read the Content-Type to choose. It reads the TTY setting of the process. The source was read at commit [fdd4b8e](https://github.com/docker/cli/tree/fdd4b8e5da335e1d0d83d29af5045f57280cd694):

- An attach and an exec, in [hijack.go](https://github.com/docker/cli/blob/fdd4b8e5da335e1d0d83d29af5045f57280cd694/cli/command/container/hijack.go#L145-L152): `if h.outputStream != nil && h.tty { io.Copy(...) } else { stdcopy.StdCopy(...) }`. The Go client of Moby records the media type of the answer, but the CLI does not use it here.
- The logs, in [logs.go](https://github.com/docker/cli/blob/fdd4b8e5da335e1d0d83d29af5045f57280cd694/cli/command/container/logs.go#L57-L81): the CLI inspects the container first (`ContainerInspect`), and then `if c.Container.Config.Tty { io.Copy(dockerCli.Out(), resp) } else { stdcopy.StdCopy(dockerCli.Out(), dockerCli.Err(), resp) }`.

## Considered Options

- **Keep the Content-Type, and treat a missing one as multiplexed.** It fixes socktainer, but a TTY exec on an engine that leaves out the Content-Type would then lose bytes to the frame reader. The package would still follow a header that the leading client ignores.
- **The TTY setting chooses, as the Docker CLI chooses.** This option was selected.

## Consequences

- An exec and `spawn()` choose from `Tty` of the exec config. They send no extra request.
- `attach()`, and thus `containers.run()`, choose from `Config.Tty` of the inspect that `attach()` already sends for the state of the container.
- `logs()` and `followLogs()` send one inspect before the logs, as `docker logs` does, and choose from its `Config.Tty`. A missing container is a `ContainerNotFoundError` from that inspect.
- No code reads the Content-Type of an output answer any more. The hijacked connection no longer carries it.
