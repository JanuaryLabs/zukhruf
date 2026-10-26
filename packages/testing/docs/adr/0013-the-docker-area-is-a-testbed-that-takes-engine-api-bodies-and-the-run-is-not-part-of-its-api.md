# The Docker area is a testbed that takes Engine API bodies, and the run is not part of its API

The Docker area had three defects (backlog #3070):

- Its container options were a vocabulary of its own: `image`, `command`, `mounts`, `memory` as a string such as `1g`, and more. A private function translated them to the Engine API body. Each Engine field that a test needed was a new option first. Backlog #2831 needed an entrypoint, and the options had none.
- `TestRun` was public. A test made it with `TestRun.fromEnvironment(process.env)` and gave it to the class. One user outside the package remained: the lock-store matrix of the mutex, which wrote a process record for each child process.
- The class `DockerFixtures` had the name of what it makes, not of what it is. A fixture is a container, a volume or a directory. The class is the engine as one test process uses it.

No consumer used the area yet (text2sql, deepagents and elt were on older versions). Thus a change now costs each consumer one move.

## Decision

1. `DockerFixtures` is now `DockerTestbed`, and `DockerFixturesOptions` is now `DockerTestbedOptions`. The constructor does not change: `new DockerTestbed({ environment: process.env })`. `environment` stays necessary. It selects the engine and carries the run. Library code never reads `process.env` (ADR 0006, ADR 0007, ADR 0009).
2. `TestRun` is not in the public API. The run stays in the package. The global setup puts it in two environment variables, `ZUKHRUF_TESTING_RUN_ID` and `ZUKHRUF_TESTING_RUN_DIR`. The testbed reads them from its `environment`.
3. A container is the Engine API body: `EngineApi.ContainerCreateRequest` of `@zukhruf/docker`. `ContainerOptions`, `Mount` and the old options are deleted. The second argument has the options of the testbed only, as `containers.create(body, { name })` of the client has:
   - `start(body, { name? })` gives an `OwnedContainer`. It stays after it stops, until disposal removes it.
   - `run(body, { name? })` gives an `ExecResult`. It removes the container. A non-zero exit code does not throw.
   - `serve(body, { internalPort, name?, healthy? })` and `reuse(body, { internalPort, name?, healthy? })` give a `ServiceContainer`.
   - `volume()`, `directory()` and `client()` do not change.
   - `defaults` is `{ Labels, HostConfig: { Memory, NanoCpus } }`: the run's labels and the default resources, in the shape of a body. Reading it writes a process record for this process, because another Docker client can create with those labels.
4. The testbed adds these values to each body before it creates the container:
   - The run's labels, in `Labels`. A run label replaces a label of the body with the same name. `reuse` adds no run labels, because a shared server outlives runs.
   - `HostConfig.Memory` of 1 GiB and `HostConfig.NanoCpus` of 1 CPU, when the body does not set them. These limits protect a shared engine from a test container, for example an SSH engine that also runs real applications.
   - For `serve` and `reuse`: `internalPort`, published on `127.0.0.1` of the engine's host.

   When the engine does not have the image, the testbed pulls it, as `docker run` does.

5. Without `name`, the engine gives the container a name. The generated name `test-<image>-<uuid>` is deleted. `reuse` without `name` still uses `zukhruf-testing-<fingerprint>`, because that name reserves the shared server atomically.
6. The configuration of a shared server, thus its fingerprint, is the body after the testbed adds its defaults, the `internalPort` and the package version. The order of the keys and the order of the `Env` entries do not select a different server.
7. `serve` does not set `AutoRemove` on a dedicated server (backlog #2832). A dedicated server is not ready when `healthy` throws, or when its container exits first. Then `serve` reads the output of the container, removes the container, and rejects. The message of the error has that output. Its `cause` is the readiness error. Before, `AutoRemove` removed an exited container before anyone read its output. `reuse` keeps `AutoRemove`, because stopping a shared server removes it. A shared server that is not ready stays running for diagnosis, as before.
8. Another client that creates with the run's labels reads them from `defaults`, for example a sandbox launcher, or a child process of the lock-store matrix of the mutex that opens a `DockerEngineStore`. That read records its process, so the global teardown keeps the run's records while the process lives.

## Considered Options

- **Keep `ContainerOptions` and add the missing fields.** Each Engine field becomes an option and a translation first. The Engine API already names and types each field, and `@zukhruf/docker` exports the type.
- **Hide `TestRun` from the exports, but keep the class.** The class did two jobs that change for different reasons. The mark of the run needs only its id: the run's label, the name of a database and the prefix of a path. The records need only the run's directory. Backlog #2843 changes the records when a run reaches more than one machine, and the marks when it adds a kind of resource. Thus the package keeps the id as a value and the records as their own part.
- **A public `recordProcess(pid)`.** Only the mutex matrix needed it. A child process that reads `defaults` records itself, so the method adds API for a case that `defaults` already covers.
- **Make `environment` default to `process.env`.** Library code never reads `process.env` (ADR 0006, ADR 0009). A test gives its environment.
- **The name `Docker`.** It is the name of the client of `@zukhruf/docker`. Six files import both, and they would need an alias.
- **The name `TestDocker`.** It does not say what the class is. "Testbed" is the term for the environment in which tests run.
- **A stable-stringify dependency for the fingerprint.** A sort of the keys is a few lines. A new dependency is not necessary for them.

## Consequences

- Each consumer moves one time to this API: text2sql, deepagents and elt.
- A consumer that spread `defaults` into the options of its own container API maps `Labels` and the resources to those options.
- A container that a test creates without `name` gets a name from the engine.
- The fingerprint changed, so each configuration gets a new shared server. A new package version already makes new shared servers, and the global teardown removes the servers of the old version (ADR 0012).
