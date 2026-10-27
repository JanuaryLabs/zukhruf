# A test process holds a process lease, and the global teardown keeps the shared servers of a version that has one

ADR 0012 made the global teardown remove the shared servers of each other version. Its premise was a version skew of zero: each consumer moves to the latest release, so no run of an older version uses an engine at the same time.

That premise is false. After each release, the consumers lock different releases for some time. On 2026-10-26, deepagents and this repository ran tests on one engine with different versions. The teardown of one run removed the Postgres server and the SQL Server server of the other run while its tests ran. Those tests failed (backlog #3128). ADR 0012 accepted this consequence. It also rejected the option "remove a server only when no other run is alive".

The teardown cannot see the test processes of another run. The other run can be in another repository, or on another machine that uses the same SSH engine. Thus the engine must show which versions have a live test process.

## Decision

1. **A lease is a container.** A lease runs `cat` (image `busybox:1.37.0`) with `OpenStdin`, `StdinOnce` and `AutoRemove`. Its holder attaches to its standard input before the start, and holds the attach. When the holder process exits for any reason, also on `SIGKILL`, the attach closes. Then `cat` reads the end of its input and exits, and the engine removes the container. The attach uses `ref: false` of `@zukhruf/docker`, so it does not keep the holder process running. The code is `EngineLease` in `src/docker/engine-lease.ts`. It is not exported.
2. **The process lease.** `reuse()` takes a process lease before it creates or finds a shared server. The lease has the labels `dev.zukhruf.testing.lease=process`, the version label with this version and, in a run, the run's label. One process has one process lease on each engine, because one process makes many testbeds (each database fixture makes its own). When the attach of the lease ends, the next `reuse()` takes a new one. Only `reuse()` takes a lease: a sweep removes only shared servers, and a run that does not use Docker must not call the engine (ADR 0012).
3. **The sweep lease.** For each other version V that has shared servers, the global teardown does these steps:
   1. It creates the sweep lease of V. Its name is `zukhruf-testing-sweep-<sha256 of V in hex>`. Its labels are `dev.zukhruf.testing.lease=sweep` and the version label V. When the name is taken, another teardown sweeps V now, and this teardown skips V.
   2. It lists the running containers with the labels `dev.zukhruf.testing.lease=process` and the version label V.
   3. When it finds one, it keeps the servers of V. When it finds none, it removes them, with force and with their anonymous volumes.
   4. It removes its sweep lease.
4. **The order in a test process.** `reuse()` takes its process lease first. Then it looks for the sweep lease of its own version. When the sweep lease exists, `reuse()` waits until the engine removes it. Then it creates or finds its server. A server that the sweep removed is created again.
5. **A sweep lease without a holder.** A teardown that is killed between the create and the start of its sweep lease leaves it `created`. A waiter removes a sweep lease that stays `created` for 5 s, or that exited. It removes it without force, so the engine lets only one of that removal and the start of the teardown succeed. When the removal wins, the start of the teardown fails, and the teardown skips V.
6. A server with no version label is removed as before: its version is older than 0.3.43, and no process of it takes a lease. The versions 0.3.43 to 0.3.46 take no lease either, so a sweep removes their servers once.

The public API does not change.

## Why the order is safe

The test process and the teardown each publish their own lease first, and then read the lease of the other. This is the order of Dekker's algorithm for two processes.

Take a process lease of V and step 2 of a teardown that sweeps V:

- When the process lease exists before step 2, the teardown sees it and keeps the servers.
- When the process lease does not exist before step 2, the process created it after step 2, thus after step 1. Then the process looks for the sweep lease after step 1, and finds it. It waits until step 4, when the removal is done. Then it creates its server again.

In both cases, no teardown removes a server that a live process of V uses.

## Precedent

- Gray and Cheriton, "Leases: An Efficient Fault-Tolerant Mechanism for Distributed File Cache Consistency" (1989): a lease ends when its holder stops, without a message from the holder.
- Testcontainers holds its Ryuk session on an open socket. Ryuk removes the containers of a session when the socket closes.
- The `DockerEngineStore` of `@zukhruf/mutex` holds a claim in the same way: a `cat` container that ends with the attach of its holder. `EngineLease` is a copy of that code (`docs/copied-code.md`).
- Dekker's algorithm: each party sets its own flag before it reads the flag of the other.

## Considered Options

- **Keep ADR 0012 and require a skew of zero.** The incident shows that consumers on one engine do not move at the same time.
- **Keep the servers of each version that a run used in the last N days.** An index of the last use is bookkeeping, and a process that runs longer than N days still loses its server.
- **A lease for each run, not for each process.** The runner of a run does not use Docker, and a run that does not use Docker must not call the engine. A process lease exists only in a process that uses a shared server.

## Consequences

- Each test process that calls `reuse()` runs one more small container on each engine that it uses. A `busybox` image is pulled once on each engine.
- A teardown keeps the servers of a version while a test process of that version runs, also on another machine that uses the same SSH engine. The next teardown after that process ends removes them.
- A test process that calls `reuse()` while a teardown sweeps its version waits until that sweep ends. The wait lasts as long as the sweep: some engine calls, and the removal of the servers.
- The servers of a version older than this change have no lease, so a teardown removes them once, also while they are in use.
- The tests are in `src/scripts/docker-global-setup.integration.test.ts`: a live process of another version keeps its servers, a killed process loses its lease, a process waits for a sweep of its version, the sweep keeps the servers of a process that looks for the sweep lease, two teardowns sweep one version, and a `created` sweep lease does not stop a process.
