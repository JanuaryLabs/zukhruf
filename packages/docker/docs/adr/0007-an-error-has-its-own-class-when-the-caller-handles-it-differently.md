# An error has its own class when the caller handles it differently

The first design had two error classes: `ConnectionFailedError`, and `DockerEngineError` with the HTTP status. A caller then tests `error.status === 409`, and a 409 has many meanings: a taken name, a volume in use, a stopped container, an image in use. The maintainer chose otherwise on 2026-10-20: "I prefer naunced error classes for cases where an error expcetion actually make a differnce."

The sandbox of `@deepagents/context` shows which errors make a difference. It matches the text of the CLI to find them, and it does something different for each:

- `isServiceDown` (`docker-sandbox.ts:533`) gives `DockerNotAvailableError`: the user must start Docker.
- `isMissingContainer` (`:539`) makes the state `'absent'`, and the sandbox creates the container again (`container-sandbox.ts:213`).
- `isNameConflict` (`:547`) makes the sandbox look again and attach to the container of the other caller (`container-sandbox.ts:147`).
- `isMissingBindSource` (`:311`) gives `VolumePathError`, which names the missing host path (`container-sandbox.ts:430`).
- `removeVolume` tries again for 30 seconds while the volume is in use (`:514-531`).

microsandbox, which the same repositories use, has 36 error classes (0.7.8). Some of them name the same kinds of cases: `SandboxNotFoundError`, `SandboxNotRunningError`, `SandboxAlreadyExistsError`, `ImageNotFoundError`, `ImageInUseError`. Many others have no handling of their own. The Go client of Moby sorts errors into categories by status (`errdefs.IsNotFound`, `IsConflict`): one category still has many meanings.

## Considered Options

- **One class with a status.** Each caller decodes the status again for each request.
- **A class for each status category**, as `errdefs` of Moby. A conflict is then still a taken name, a volume in use or a stopped container.
- **A class for each case that a caller handles differently.** This option was selected.

## Consequences

- The package has a class for each of these cases, and for no others: `ConnectionFailedError`, `UnsupportedHostError`, `ContextNotFoundError`, `UnsupportedEngineError`, `ContainerNotFoundError`, `ContainerNotRunningError`, `ContainerRunningError`, `NameConflictError`, `ImageNotFoundError`, `NetworkNotFoundError`, `VolumeNotFoundError`, `BindSourceNotFoundError`, `VolumeInUseError`, `NetworkInUseError`, `ImageInUseError`, `PathNotFoundError`, `NotAFileError` and `ReadOnlyPathError`. The README gives the next step of the caller for each one.
- `DockerError` is the base of every error of the package. `DockerEngineError` extends it, and it is the base of every class that comes from an answer of the engine. A broad catch still works, and an error with no class of its own stays a `DockerEngineError`, for example an error in the progress of a pull.
- A class carries what its handling needs: the container, the name, the state, the host path.
- The class comes from the request and its status, not from the text. When one status has two meanings, the package sends one more request:
  - A 404 of `POST /containers/create` is a missing image. A missing network does not fail the create: the engine answers 201, and `start()` then gets 404 ("failed to set up container networking: network … not found", probed on 2026-10-20 at API 1.44, 1.51 and 1.56). An engine in swarm mode answers that start with 500 ("Could not attach to network … rpc NotFound", limerence-dokploy, API 1.51). Thus a 404 or 500 of `start()` is a missing container, a missing network, or another failure: an inspect of the container tells whether the container is gone, and a lookup of each of its networks names the missing one. Else the error stays a `DockerEngineError`.
  - A 409 of `DELETE /containers/{id}` is a removal that is already in progress, or a container that runs and gets no `force`. An inspect tells which: the first waits until the container is gone, and the second is `ContainerRunningError`.
  - A 404 of `/containers/{id}/archive` is a missing container or a missing path ("Container or path does not exist" in the Engine API reference). An inspect of the container tells which.
  - A 409 of an exec, an attach or a kill means the container does not run. An inspect gives its `state`, because the next step for `paused` (unpause) differs from the next step for `exited` (start).
  - A 403 of `DELETE /networks/{id}` is a pre-defined network or a network with connected containers. An inspect of the network tells which.
  - The engine refuses an extraction into a read-only place with 400, the status of each bad parameter, although the reference documents 403. An inspect of the container tells: `HostConfig.ReadonlyRootfs`, and the `RW` flag of the mount that holds the directory.
  - Moby gives no 409 for an attach to an exited container. Thus `attach()` inspects the container first, and its state decides.
- One class needs the text: `BindSourceNotFoundError`. The engine answers a missing bind source with the same status as other bad parameters. Moby builds the text from one fixed format, `"bind source path does not exist: %s"` (`errBindSourceDoesNotExist` in [`daemon/volume/mounts/validate.go`](https://github.com/moby/moby/blob/master/daemon/volume/mounts/validate.go)), and the package reads the path from it.
- A removal of a container whose removal is already in progress gets 409. The package waits until the container is gone, as the global teardown of `@zukhruf/testing` does today. A caller does nothing different, so it gets no class.
