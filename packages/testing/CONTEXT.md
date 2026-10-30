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

**Shared server**:
A service container that `reuse()` shares between processes and runs, one per configuration and package version.
_Avoid_: Global container, singleton

**Prebuilt fixture**:
A shared server that the global setup creates before the run starts, so that the time limit of a test does not count its start. `prebuild` makes one from each acquisition that a project gives it: it acquires the fixture and disposes it. The term is from Meszaros, _xUnit Test Patterns_ (2007). Without it, `reuse()` creates the server in the first test that needs it: Meszaros calls this Lazy Setup.
_Avoid_: Warm-up, prewarm, preheat

**Lease**:
A container that runs `cat` on the standard input of the attach of its holder process. When the holder exits for any reason, the attach closes and the engine removes the lease. A process lease tells a global teardown that a test process of a version uses its shared servers now. `reuse()` takes one for each process and engine.
_Avoid_: Heartbeat, lock, Ryuk session

**Sweep lease**:
The lease that a global teardown holds while it removes the shared servers of another version. Its name comes from that version, so one teardown at a time sweeps a version. A test process of that version waits until the sweep lease is gone.
_Avoid_: Sweep lock

**Run**:
One `node --test` invocation with the Docker global setup. What its test processes create carries the run's label, or a record in the run's directory.
_Avoid_: Session, scope

**Global setup**:
Node's hook that starts a run before the test processes start. It does recovery first.
_Avoid_: Wrapper

**Global teardown**:
Node's hook that removes what the run created after its test processes end. It is synchronous: it starts a worker thread that sends the requests to the engine, and it waits for that worker.
_Avoid_: Cleanup hook

**Runner**:
The `node --test` process that runs the global setup, starts the test processes and runs the global teardown.

**Process record**:
A record in the run's directory that names a process that can create something for the run: a test process, another process that reads `defaults`, or an SSH command that a test process started. A test process records itself on the first acquisition of a `DockerTestbed`, which every database fixture makes. A process also records itself when it reads `defaults`, because another Docker client in that process can create with those labels, for example a sandbox launcher. While a recorded process lives, the run's records stay.
_Avoid_: Worker record, PID file

**Creating record**:
A record in the run's directory that a test process writes while it asks the engine to create a container. The engine can finish the create after the process died. While a creating record remains, the global teardown keeps the run's records, and the recovery of a later run sweeps the run again.

**Recovery**:
A later run removing what an earlier run left, because the earlier run's global teardown did not run, failed, or kept the records for a process that still lived. Recovery waits until that run's runner and recorded processes have ended.
_Avoid_: Garbage collection, prune

**Area**:
A part of the package with its own import path, such as `docker` or `postgres`.
_Avoid_: Module, entry

**Temporary directory**:
An empty directory that `TemporaryFiles` creates for one test, below a parent directory. Its handle gives the real path. Disposal removes it, and retries the removal for at most 1.8 s.
_Avoid_: Scratch directory, tmpdir

**Interception**:
An msw server in the test process that answers requests with the test's handlers, fails each request that no handler answers, and records a clone of each request.
_Avoid_: Mock server
