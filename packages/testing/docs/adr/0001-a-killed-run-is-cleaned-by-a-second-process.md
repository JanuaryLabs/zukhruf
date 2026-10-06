# A killed run is cleaned by a second process

Disposal removes a fixture when its scope ends, also after a failure. A test process that is killed never ends its scopes: a timeout with `--test-force-exit`, Ctrl-C, or an out-of-memory kill. Its containers keep running, because a detached container does not stop when the process that started it dies, and `--rm` acts only on a container that stops. Thus a second process, the supervisor, starts the run and cleans up after it. A `Docker` labels each container and volume with the run's id, and records each SSH forward and host directory in the run's directory. When the test processes exit, the supervisor stops their process group and removes what carries the run. A run whose supervisor also died is removed by the next supervisor on the same engine.

## Considered Options

- **An exit hook in the test process.** A killed process runs no hook.
- **A container that stops with its client**, for example a container attached to the `docker run` that started it. The container keeps running when the client is killed, and an SSH engine loses the client's connection without stopping the container.
- **Remove containers by name.** A name proves nothing about ownership: another run, another project or a person can start a container with a similar name. A label is attached when the container is created, so it marks exactly the containers of one run.
- **Keep the records in the project**, for example in `node_modules/.cache`. Then only the same project recovers its own runs. The records are kept per user instead, so any project recovers a run that another project left on the same engine.

## Consequences

- The run reaches the test processes through two environment variables. Library code never reads `process.env`: a test passes `TestRun.fromEnvironment(process.env)` to `Docker`.
- Supervisors start in parallel, for example for two Nx projects. A supervisor claims a dead run by renaming its directory, so only one supervisor recovers it.
- The supervisor stops a run as a process group, which Windows does not have. It refuses to start there.
- Shared servers outlive runs on purpose. The supervisor never removes a container with the shared-server label.
