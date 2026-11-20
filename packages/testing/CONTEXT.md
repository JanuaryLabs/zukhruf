# Testing

Native Node.js test registration and fixtures that an integration test acquires and disposes. The package owns no test data and no product wiring: those stay in the tests.

## Language

**Parameterized test**:
One test body registered separately for each named row in an explicit table. Also called a table-driven test. A parameterized suite repeats a group of tests for each row; each test owns its fixtures.

**Fixture**:
A resource that a test acquires and that cleans up when its scope ends: a container, a database, a server, a stream.
_Avoid_: Helper, harness (for the resource itself)

**Acquisition**:
A call that creates a fixture and returns its handle.
_Avoid_: Setup

**Handle**:
What an acquisition returns. Disposing it cleans up the fixture.
_Avoid_: Instance, connection

**Engine**:
The Docker daemon that the environment selects as the Docker CLI selects it, local or over SSH. `@zukhruf/docker` does the selection and sends the requests; the package uses no Docker CLI. A handle keeps the engine it was created on.
_Avoid_: Host, daemon (for the selection)

**Testbed**:
The engine that the environment selects, as one test process uses it. A `DockerTestbed` acquires containers, volumes and directories on it, and marks each with the run.
_Avoid_: Fixtures (a fixture is what the testbed acquires)

**Container**:
A container that this process started and owns. It stays after it stops, until disposal removes it.

**Service container**:
A container whose port answers on 127.0.0.1 of this machine.
_Avoid_: Server container

**Dedicated server**:
A service container that one handle owns: `serve()` of a `DockerTestbed`, or `start()` of a database, gives it. Failure or disposal of the handle removes its container. It is the opposite of a shared server.
_Avoid_: Private server, own server

**Shared server**:
A service container that `reuse()` shares between processes, runs and versions of this package, one for each request. Its name and its label `dev.zukhruf.testing.server` hold the fingerprint of the request. The reaper of a run removes a shared server that is older than its time to live (TTL) of 7 days, when no process lease holds it.
_Avoid_: Global container, singleton

**Fingerprint**:
The SHA-256 hash of a request to `reuse()`: the container body after the testbed adds its defaults and the published port, and the `internalPort`. The order of the keys does not change it. It names the shared server of the request, `zukhruf-testing-<fingerprint>` when the request gives no `name`, and the label `dev.zukhruf.testing.server` of that server holds it (ADR 0019).
_Avoid_: Key, ID (for the hash)

**Lease**:
A container that runs `cat` on the standard input of the attach of its holder process. When the holder exits for any reason, the attach closes and the engine removes the lease. A process lease tells a reaper that a test process uses one shared server now. `reuse()` takes one for each process and shared server.
_Avoid_: Heartbeat, lock, Ryuk session

**Sweep lease**:
The lease that a reaper holds while it looks for the process leases of one shared server and removes that server. Its name comes from the fingerprint of the server, so one reaper at a time sweeps a server. A test process of that server waits until the sweep lease is gone.
_Avoid_: Sweep lock

**Run**:
One `node --test` invocation with the Docker global setup. What its test processes create carries the run's label, or a record in the run's directory.
_Avoid_: Session, scope

**Global setup**:
Node's hook that starts a run before the test processes start. It does recovery first.
_Avoid_: Wrapper

**Global teardown**:
Node's hook that runs after the test processes of a run end. It is synchronous and makes no engine call: it removes the folder of the run's sockets in `/tmp`, and then the run's directory.
_Avoid_: Cleanup hook

**Reaper**:
A container of one run on one engine (ADR 0020). It mounts a socket of the engine's host, and lets a holder in only after it finds itself through that socket. Each test process of the run holds it with one `cat` exec, and takes the hold again at once when it ends while the process lives. About 2 s after the last holder ended, it closes, so a later holder holds the next reaper of the run, and it removes the run's containers and volumes and its host directories, drops the run's databases in the shared servers, checks again a few times, removes the expired shared servers, and exits.
_Avoid_: Ryuk, janitor

**Hold**:
The one `cat` exec of a test process on the reaper of its run, that a `ReaperHold` takes before the process creates anything on the engine (ADR 0020). It ends when the process exits, for any reason, and it does not keep the process running. When it ends while the process lives, the process takes it again at once, on the same reaper or on the next reaper of the run.
_Avoid_: Lease (a lease is a container), session

**Runner**:
The `node --test` process that runs the global setup, starts the test processes and runs the global teardown.

**Run's SSH connection**:
The one SSH connection that the global setup holds for a run on an SSH engine and serves to the run's test processes, from the folder `/tmp/zukhruf-testing-<run id>/` (ADR 0024): `docker.sock` carries the Engine API, and `ssh.sock` is the control master for shells and forwards.
_Avoid_: Tunnel, forward record

**Recovery**:
A later run on the same engine removing what an earlier run left on this machine when its global teardown did not run or failed: the folder of the earlier run's sockets, and then its records. It makes no engine call: the earlier run's reaper removes its engine objects (ADR 0025). Recovery waits until that run's runner has ended.
_Avoid_: Garbage collection, prune

**Wait**:
A call that resolves when a fact is true, and that the test's signal limits. `waitFor` calls a check until it passes; `next` resolves with a message of a worker process.
_Avoid_: Poll loop, sleep

**Worker process**:
A Node process that a test starts with `startWorker`, with an IPC channel back to the test. Its handle records the messages it sends. It exits when its handle is disposed or the test process ends.
_Avoid_: Child, subprocess (for the handle)

**Area**:
A part of the package with its own import path, such as `docker` or `postgres`.
_Avoid_: Module, entry

**Temporary directory**:
An empty directory that `TemporaryFiles` creates for one test, below a parent directory. Its handle gives the real path. Disposal removes it, and retries the removal for at most 1.8 s.
_Avoid_: Scratch directory, tmpdir

**Interception**:
An msw server in the test process that answers requests with the test's handlers, fails each request that no handler answers, and records a clone of each request.
_Avoid_: Mock server

**Preload**:
A module that Node.js runs in a child process before the entry point of the child, from the `--import` flag. A preload of this package is a file of the package. Its URL gives it its settings.
_Avoid_: Loader, shim
