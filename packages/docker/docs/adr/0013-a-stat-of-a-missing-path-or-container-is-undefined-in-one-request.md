# A stat of a missing path or container is undefined in one request

`container.stat(path)` sends `HEAD /containers/{id}/archive?path=…`. The engine answers 404 for two cases:

- The container does not exist: "No such container: X".
- The path does not exist in the container: "Could not find the file P in container X" (`containerFileNotFound` in [daemon/errors.go](https://github.com/moby/moby/blob/06db1734267bf7770914b417bff6556d835bf8cc/daemon/errors.go#L94-L101), from `ContainerStatPath` in [daemon/archive.go](https://github.com/moby/moby/blob/06db1734267bf7770914b417bff6556d835bf8cc/daemon/archive.go#L14-L32)).

The text is only in the JSON body. An answer to `HEAD` has no body, and no header holds the error ([router/container/copy.go](https://github.com/moby/moby/blob/06db1734267bf7770914b417bff6556d835bf8cc/daemon/server/router/container/copy.go#L32-L44)). Thus the status alone cannot tell the two cases apart.

Before this decision, `stat()` sent an inspect of the container after each 404, by the rule of [ADR 0007](./0007-an-error-has-its-own-class-when-the-caller-handles-it-differently.md): "When one status has two meanings, the package sends one more request". A missing path gave `undefined`, and a missing container gave `ContainerNotFoundError`. `writeFiles()` calls `stat()` for each directory that it goes up to find the deepest directory that exists. Thus each missing parent directory cost two requests: a `HEAD` and an inspect. Backlog #4197 asked whether the second request is necessary.

The maintainer gave the rule on 2026-11-13: follow what the leading tools do.

This is what the leading tools do. Their source was read on 2026-11-13 at the commits of the links. The engine was read from source and not probed.

| Tool                                                                                                                                                                                                                                                                       | Request after a 404 of the stat | What the caller gets                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Go client of Moby ([container_copy.go](https://github.com/moby/moby/blob/06db1734267bf7770914b417bff6556d835bf8cc/client/container_copy.go#L27-L47), [request.go](https://github.com/moby/moby/blob/06db1734267bf7770914b417bff6556d835bf8cc/client/request.go#L222-L269)) | None                            | One not-found error for both cases. It reads no body for `HEAD`, so the message is generic: "request returned 404 Not Found …"               |
| Docker CLI, `docker cp` ([cp.go](https://github.com/docker/cli/blob/fdd4b8e5da335e1d0d83d29af5045f57280cd694/cli/command/container/cp.go#L373-L402))                                                                                                                       | None                            | It ignores the error of the stat of the destination. The `PUT` or `GET` that follows has a body, and its 404 gives the message of the engine |
| dockerode ([container.js](https://github.com/apocas/dockerode/blob/446e07cbed52571d7951afc1353fb981593685b9/lib/container.js#L932-L948))                                                                                                                                   | None                            | One error for both cases, with the label "no such container"                                                                                 |
| bollard ([container.rs](https://github.com/fussybeaver/bollard/blob/46df0d3139cbe2791036150ef7111e6d511392dc/src/container.rs#L858-L893), [docker.rs](https://github.com/fussybeaver/bollard/blob/46df0d3139cbe2791036150ef7111e6d511392dc/src/docker.rs#L1943-L1962))     | None                            | `DockerResponseServerError` with the status 404 and an empty message                                                                         |
| docker-py ([container.py](https://github.com/docker/docker-py/blob/e734fd5a5508bc1062a28a51dc2f31ae47af7a2f/docker/api/container.py#L725-L775))                                                                                                                            | Not applicable                  | It has no `HEAD`. `get_archive()` reads the stat from the header of the `GET`, and a 404 of the `GET` has a body                             |

No surveyed client sends a second request after a 404 of the stat. Each client that sends the `HEAD` gives one "not found" for both cases.

The consumers do not need the difference either. The volume adapter of text2sql and the Docker sandbox of deepagents use `stat()` to check that a path exists, and they treat each miss as "the path is missing". For them a miss is the usual answer.

## Considered Options

- **Keep the inspect after each 404.** The caller gets `ContainerNotFoundError` for a missing container. No surveyed client does this, no consumer uses it, and each miss costs two requests.
- **Inspect once for each `writeFiles()` call.** It removes the second request from the loop of `writeFiles()`, but a call of `stat()` by a caller still costs two requests. It also keeps a rule that no surveyed client has.
- **The way of the leading clients: a 404 of the stat is `undefined` in one request.** This option was selected.

## Consequences

- `stat()` gives `undefined` for a 404, for a missing path and for a missing container. It sends one request and no inspect. It does not reject with `ContainerNotFoundError` any more.
- Each other answer that is not a path stat stays a `DockerEngineError` with its status, as before.
- `readFile()`, `getArchive()`, `putArchive()` and `writeFiles()` keep the inspect after their 404, so a missing container still makes them reject with `ContainerNotFoundError`. Their 404 has a body, and no caller asked for a change. A caller that must know that the container exists can call `readFile()` or `container.inspect()`.
- `writeFiles()` sends one request for each missing parent directory, not two. For `a/b/c.txt` with two missing parents, it sends two stats and one `PUT`, where it sent two stats, two inspects and one `PUT`. For a missing container, `writeFiles()` goes up to `/` and its `PUT` rejects with `ContainerNotFoundError`.
- `stat()` is an exception to the rule of [ADR 0007](./0007-an-error-has-its-own-class-when-the-caller-handles-it-differently.md) and to the inspect after a 404 in [ADR 0006](./0006-files-move-through-the-archive-requests-not-through-exec.md).
- These parts were not covered: no engine was probed for the two 404 answers, and the clients were read, not run.
