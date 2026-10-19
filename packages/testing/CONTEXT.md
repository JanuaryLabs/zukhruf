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
The Docker daemon that the Docker CLI selects, local or over SSH. A handle keeps the engine it was created on.
_Avoid_: Host, daemon (for the selection)

**Container**:
A container that this process started and owns. It stays after it stops, until disposal removes it.

**Service container**:
A container whose port answers on 127.0.0.1 of this machine.
_Avoid_: Server container

**Shared server**:
A service container that `reuse()` shares between processes and runs, one per configuration.
_Avoid_: Global container, singleton

**Background server**:
An HTTP server whose scope is the process. It serves until the process exits and never keeps the process running. Its acquisition returns the origin, not a handle.
_Avoid_: Daemon, global server, unref'd server

**Run**:
One `node --test` invocation with the Docker global setup. What its test processes create carries the run's label, or a record in the run's directory.
_Avoid_: Session, scope

**Global setup**:
Node's hook that starts a run before the test processes start. It does recovery first.
_Avoid_: Wrapper

**Global teardown**:
Node's hook that removes what the run created after its test processes end. It is synchronous.
_Avoid_: Cleanup hook

**Runner**:
The `node --test` process that runs the global setup, starts the test processes and runs the global teardown.

**Process record**:
A record in the run's directory that names a process that can create something for the run: a test process, or a Docker or SSH command that it started. While a recorded process lives, the run's records stay.
_Avoid_: Worker record, PID file

**Recovery**:
A later run removing what an earlier run left, because the earlier run's global teardown did not run, failed, or kept the records for a process that still lived. Recovery waits until that run's runner and recorded processes have ended.
_Avoid_: Garbage collection, prune

**Area**:
A part of the package with its own import path, such as `docker` or `postgres`.
_Avoid_: Module, entry
