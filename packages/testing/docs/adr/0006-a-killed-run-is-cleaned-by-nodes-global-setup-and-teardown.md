# A killed run is cleaned by Node's global setup and teardown

Disposal removes a fixture when its scope ends, also after a failure. A test process that is killed does not end its scopes. This occurs with a timeout under `--test-force-exit`, with Ctrl-C, and with an out-of-memory kill. Its containers keep running, because a detached container does not stop when the process that started it dies, and `--rm` acts only on a container that stops. Thus the runner cleans up after its test processes. Node's `--test-global-setup` gives the runner a global setup and a global teardown. The global setup starts the run and does recovery. A `Docker` labels each container and volume with the run's id. It records each SSH forward and host directory in the run's directory. It also writes a process record for its test process, and for each Docker or SSH command that it starts. The global teardown removes what carries the run. A run whose global teardown did not run or failed is removed by a later run on the same engine.

## Considered Options

- **The supervisor command (replaced).** `zukhruf-docker-tests` started `node --test` in its own process group, and stopped that group before it cleaned up. Node's runner now does this supervision, so the package no longer owns it. The process-group stop also had defects of its own: macOS can report `EPERM` while it removes an empty group (backlog #2237).
- **Testcontainers' Ryuk.** Ryuk removes Docker objects only. It does not remove the host directories on a remote engine or the SSH forward directories. It also needs a container with the engine's socket mounted, which a shared server must allow.
- **An exit hook in the test process.** A killed process runs no hook.
- **A container that stops with its client**, for example a container attached to the `docker run` that started it. The container keeps running when the client is killed, and an SSH engine loses the client's connection without stopping the container.
- **Remove containers by name.** A name proves nothing about ownership: another run, another project or a person can start a container with a similar name. A label is attached when the container is created, so it marks exactly the containers of one run.
- **Keep the records in the project**, for example in `node_modules/.cache`. Then only the same project recovers its own runs. The records are kept per user instead, so any project recovers a run that another project left on the same engine.
- **An asynchronous global teardown.** Under `--test-force-exit`, Node calls the teardown and does not wait for it before it exits (`internal/test_runner/test` lines 1490-1492 in Node 26: `this.harness.teardown()`, then `process.exit()`). Thus the teardown stops at its first `await`.
- **Keep an ended run's records for one Docker CLI timeout.** A `docker run` that a killed test process started has no timeout: the timer died with that process. A process record ends when the process ends, so no time limit is necessary.

## Consequences

- The run reaches the test processes through two environment variables. Library code never reads `process.env`: a test passes `TestRun.fromEnvironment(process.env)` to `Docker`.
- A consumer re-exports `globalSetup` and `globalTeardown` from one file, and gives that file's path to `--test-global-setup`. Node does not accept a package name there.
- The global teardown is synchronous. It runs the Docker CLI and `ssh` with `execFileSync`, and it finishes under `--test-force-exit`, after a test timeout and after Ctrl-C.
- The global teardown deletes the run's records only when every recorded process has ended. Otherwise a later run removes what is left after those processes end. Recovery does not touch a run while its runner or a recorded process lives. A process id that the system gives again to a new process only delays recovery.
- The runner does not stop the processes that test code started and left running. The package's own commands end by themselves: a Docker CLI call after 240 s, a remote shell command after 30 s, and an SSH forward when the process that opened it ends.
- Runners start in parallel, for example for two Nx projects. A runner claims a dead run by renaming its directory, so only one runner recovers it.
- The global setup reads the engine with `docker context inspect`, so a run needs the Docker CLI. It calls the engine only when a dead run on that engine has process records to sweep.
- One test file at a time on an SSH engine is the consumer's choice: `--test-concurrency=1`.
- An SSH forward runs `cat` in a remote shell. When the process that opened the forward dies, its standard input closes and the forward ends. The SSH user thus needs a shell on the engine's host. Closing a forward over a dead connection waits up to one second before it kills `ssh`.
- The package has no command (`bin`) now.
- Shared servers outlive runs on purpose. The global teardown never removes a container with the shared-server label.
- Nothing refuses to start on Windows now, because no process group is used.
