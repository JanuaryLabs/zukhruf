# HostConfig grows field by field from the Engine API reference

`EngineApi.HostConfig` is the part of the body of `POST /containers/create` that depends on the host. The first version had 25 fields. The sandbox of `@deepagents/context` sets eight more with flags of `docker run` (`docker-sandbox.ts:355-445`): `--ulimit`, `--sysctl`, `--runtime`, `--dns`, `--device`, `--gpus`, `--cpuset-cpus` and `--memory-swap`. The type did not have them, so the sandbox could not move to the package (zukhruf backlog #3178, gap G6; deepagents #2760).

The Engine API reference at version 1.44 has about 80 fields in `HostConfig`, with its `Resources`.

## Considered Options

- **An index signature**, such as `[field: string]: unknown`. Each name then type-checks, and a wrong name such as `Ulimit` goes to the engine. The engine ignores a field that it does not know, so the container runs without the limit, and no error tells the caller.
- **Each field, generated from the specification.** [ADR 0001](./0001-the-client-speaks-the-engine-api-not-the-docker-cli.md) and [ADR 0003](./0003-the-package-leads-and-the-repositories-change.md) refuse a generated API.
- **A field comes into the type when a caller needs it, with the name and the type of the reference at API 1.44.** This option was selected.

## Consequences

- Each field has the name and the type that the reference gives it at API 1.44, the lowest version of the package. A field that only a higher version has does not come into `HostConfig` this way: it needs its own check of the API version, as [ADR 0009](./0009-a-platform-below-its-api-version-fails-and-is-not-ignored.md) does for the platform of images.
- A type that the reference names keeps that name: `DeviceMapping`, `DeviceRequest`. The item of `Ulimits` has no name in the reference, so it has the name of Moby, `Ulimit`.
- The test of each field creates a container with it and reads it back from an inspect. The engine echoes each field that it knows, so a wrong name fails the test.
- The engine keeps a `DeviceRequests` entry at the create, also on a host with no GPU. The start then fails with 500 ("failed to discover GPU vendor from CDI: no known GPU vendor found", Docker Desktop, API 1.56, 2026-10-27). The package gives no class for it: the caller does nothing different from other failed starts.
