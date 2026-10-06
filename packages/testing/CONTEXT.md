# Testing

Fixtures that an integration test acquires and disposes. The package owns no test data and no product wiring: those stay in the tests.

## Language

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

**Run**:
One supervised `node --test` invocation. What its test processes create carries the run's label, or a record in the run's directory.
_Avoid_: Session, scope

**Supervisor**:
The `zukhruf-docker-tests` process that starts a run, and removes what the run created after its test processes exit.
_Avoid_: Runner, wrapper

**Recovery**:
A supervisor removing what an earlier run left, because that run's supervisor died before it could.
_Avoid_: Garbage collection, prune

**Area**:
A part of the package with its own import path, such as `docker` or `postgres`.
_Avoid_: Module, entry
