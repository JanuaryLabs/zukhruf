# A reaper container removes a run's engine objects when the attach that holds it closes, and recovery keeps the local records

Status: Accepted (2026-11-14, backlog #4205 with #2843). No code exists. It supersedes these parts of [ADR 0006](./0006-a-killed-run-is-cleaned-by-nodes-global-setup-and-teardown.md):

- the rejected option "Testcontainers' Ryuk";
- the consequence "The global teardown is synchronous ..." (the worker, `Atomics.wait`, 250 s and 240 s), for engine objects;
- the consequence about creating records and the 240 s recovery window;
- the engine part of "The global teardown removes what carries the run".

The rest of ADR 0006 stays: the run, its labels, the process records, the run's directory, recovery of local records, and the claim of a dead run by a rename.

## Context

### The cost today

The global teardown waits for its cleanup worker with `Atomics.wait` for at most 250 s (`CLEANUP_TIMEOUT` in `src/scripts/docker-global-setup.ts`). The worker gives each request to the engine 240 s (`ENGINE_CALL_TIMEOUT` in `src/scripts/run-cleanup.ts`). `Atomics.wait` takes only real time, and `AbortSignal.timeout` does not read the clock input. Thus the tests of these two budgets wait the real time. In the #3737 replica run (4 CPUs, `--parallel=3`, 2026-11-09):

| Test                                                                                                                                                             | File                                                          | Time  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----- |
| a global teardown whose cleanup takes longer than 250 s keeps the run's records and sets exit code 1                                                             | `src/scripts/docker-global-setup-timeout.integration.test.ts` | 251 s |
| a recovery whose drop of a dead run's database never gets an answer from its server ends within the engine call timeout, keeps that database and removes the run | `src/scripts/database-cleanup.integration.test.ts`            | 244 s |

`testing:test` is the longest task on the CI critical path. A test-only option is not allowed. The maintainer asked a different question on 2026-11-14: "can we eliminate the whole point of setting timeout and make it natural?". The ruling was to follow the leading tools: testcontainers' Ryuk removes the resources after the test process disconnects, so no test process waits.

### Why ADR 0006 rejected Ryuk

ADR 0006 says:

> Ryuk removes Docker objects only. It does not remove the host directories on a remote engine or the SSH forward directories. It also needs a container with the engine's socket mounted, which a shared server must allow.

The first two sentences stay true. This ADR answers them with a split: the reaper removes the engine objects, and recovery keeps the local records (see Decision 6). The third sentence had no evidence. The probe below tested it.

### The probe of 2026-11-14

The probe is in `~/.claude/scratch/4205/` (`fact-a.sh`, `client.ts`, `harness.ts`, `run-all.sh`, `logs/`).

- **Fact (a): an engine allows a container with its socket mounted.** A container with `/var/run/docker.sock` mounted created, listed and removed labelled containers and volumes on Docker Desktop (engine 29.8.0) and on the SSH engine `limerence-dokploy` (engine 28.5.0, with AppArmor, seccomp, a cgroup namespace and swarm active). Neither engine refused it.
- **Fact (b): a reaper held by a stdin attach removes the run's objects after `SIGKILL`.** The client created the reaper as `EngineLease` creates a lease (`OpenStdin`, `StdinOnce`, `AttachStdin`, attach with `ref: false`). It wrote one filter line, created labelled objects, and was killed with `SIGKILL`. The reaper read the end of its input, waited 2 s, did one pass (`docker rm -f -v` by the filter, then `docker volume rm -f`), and did 5 more passes 1 s apart.

| Engine                          | Cases                                               | Runs | Objects left after 15 s | Removal after the kill | Reaper exit |
| ------------------------------- | --------------------------------------------------- | ---- | ----------------------- | ---------------------- | ----------- |
| Docker Desktop 29.8.0           | settled, create in flight at once, at a random time | 15   | 0                       | 2.12 s to 2.15 s       | 0           |
| `limerence-dokploy` 28.5.0, SSH | settled, create in flight at once, at a random time | 15   | 0                       | 2.26 s to 3.93 s       | 0           |

The SSH times include the poll of the harness over SSH. Creates that were in flight at the kill were removed too: the engine finished them before the first pass.

### Survey

| Tool                                                                                                                                                  | What holds the session                                                                                                                          | What it removes                                                | After the session ends                                                                                                                                  | Its own timeouts                                               | How its tests prove them                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| [moby-ryuk](https://github.com/testcontainers/moby-ryuk) 0.14.0, `reaper.go`                                                                          | A TCP connection to port 8080. Each client sends `label=k=v` lines and gets `ACK`.                                                              | Containers (with force and volumes), networks, volumes, images | It waits `RYUK_RECONNECTION_TIMEOUT` (10 s; 60 s when no client ever connected). It re-checks every 1 s for matches newer than its pass. Then it exits. | A request timeout of 10 s and 10 retries, from its environment | Its tests set the budgets to 50 ms to 500 ms |
| [testcontainers-node](https://github.com/testcontainers/testcontainers-node)                                                                          | One Ryuk for each process, under a file lock for each user, found again by label. One unref'd socket for each process, with a session-id label. | Through Ryuk                                                   | Through Ryuk                                                                                                                                            | Through Ryuk. `TESTCONTAINERS_RYUK_DISABLED` gives no cleanup. | -                                            |
| [testcontainers-go](https://github.com/testcontainers/testcontainers-go)                                                                              | One Ryuk for each `go test` session. The session id is a hash of the parent PID and its start time.                                             | Through Ryuk                                                   | Through Ryuk                                                                                                                                            | Through Ryuk                                                   | -                                            |
| `EngineLease` ([ADR 0014](./0014-a-test-process-holds-a-process-lease-and-the-global-teardown-keeps-the-shared-servers-of-a-version-that-has-one.md)) | A stdin attach to a `cat` container                                                                                                             | Itself (`AutoRemove`)                                          | `cat` exits at the end of its input, and the engine removes the lease                                                                                   | None                                                           | A killed process loses its lease             |
| Kubernetes garbage collector (#2843)                                                                                                                  | `ownerReferences` on each dependent                                                                                                             | Each dependent of an owner that is gone                        | A controller outside the owner removes the dependents                                                                                                   | Its own                                                        | -                                            |
| This package today (ADR 0006)                                                                                                                         | Process records and creating records in the run's directory                                                                                     | Containers, volumes, forwards, directories, databases          | The global teardown, in a worker. A later run's recovery when the teardown did not run or failed.                                                       | 250 s for the worker, 240 s for each engine call               | The tests wait the real 250 s and 240 s      |

None of the leaders proves its own timeout with a fake clock. Each gives a real short limit to the unit that owns the timeout.

## Decision

1. **The reaper.** A reaper is a container with the engine's socket mounted. A holder process attaches to its standard input before the start, as `EngineLease` does, with `ref: false`. The holder writes the filter of what the reaper removes as the first line. When the holder exits for any reason, also on `SIGKILL`, the attach closes and the reaper reads the end of its input. Then the reaper removes what matches its filter, and exits. The reaper has `AutoRemove`, so the engine removes it after it exits. The attach is the session, not a TCP port: the port of Ryuk must be reachable from the client, and on an SSH engine it is not. The stdin attach goes through the same transport as each other engine request.
2. **What the reaper removes.** It removes the containers with the run's label, with force and with their anonymous volumes, and then the volumes with the run's label. It never removes a container with the shared-server label (ADR 0006 and [ADR 0019](./0019-a-shared-servers-name-comes-from-its-request-and-the-global-teardown-removes-it-after-a-ttl.md)). Item 8 says how the reaper drops the run's databases inside shared servers.
3. **The grace and the re-check passes.** The engine can finish a create after the process that sent it died. Thus the reaper waits a grace after the end of its input, and then does its first pass. After the first pass it does more passes at an interval, as Ryuk does. A pass that finds an object removes it.
4. **The reaper's timeouts are its own configuration.** The grace, the re-check interval, the number of re-check passes, the time limit of each request to the engine and the number of retries are inputs of the reaper, in the environment of its container, as Ryuk reads `RYUK_*`. The testbed gives the defaults. The first defaults are the values of the probe and of Ryuk: a grace of 2 s, 5 re-check passes 1 s apart, 10 s for each request and 10 retries. The tests of the reaper start a reaper with short values (tens of milliseconds), as the tests of Ryuk do. This is not a test-only option of a test process: the reaper is its own unit, and these are its inputs.
5. **What goes away in the test process.**
   - The global teardown no longer waits for the engine. The worker, `Atomics.wait` and `CLEANUP_TIMEOUT` (250 s) go away for the engine objects.
   - The test-process side of `ENGINE_CALL_TIMEOUT` (240 s) goes away: the cleanup of the run's objects, `connectAndCleanup`, the connect of recovery, and the 240 s window of creating records. The re-check passes of the reaper do the job of the creating records.
   - The two tests in the table above become tests of the reaper with short timeouts: "a reaper whose removal takes longer than its request time limit retries and exits", and "a reaper whose drop of a database never gets an answer ends within its request time limit and keeps that database".
6. **Local records stay with recovery.** The reaper runs on the engine's host. It cannot reach the SSH forward directories or the temporary directories on the machine of the test process. These records stay in the run's directory. The global teardown removes them with synchronous file system calls, which need no worker. Recovery of a later run removes what a killed run left, as ADR 0006 says.

7. **One reaper for each run.** The first test process that uses Docker creates the run's reaper on its first use, on each engine. Each test process holds its own stdin attach to that reaper. The reaper acts when the last attach closes. A run that never uses Docker makes no engine call, so ADR 0012 and ADR 0014 stay true. The filter is the run's label. testcontainers-go has the same shape: one Ryuk for each test session, started with the first container.
8. **Databases inside shared servers.** The reaper drops the run's databases by an exec into each shared server, with the server's own client (`psql`, `mysql`, `sqlcmd`, with the credentials in `Config.Env`). Thus the teardown makes no engine call. A probe proves the clients in each image and the time of an exec on a loaded server before code.
9. **The TTL sweep of shared servers.** `removeExpiredServers` (ADR 0019, 7 days) moves into the reaper. The reaper does it after the pass of its run. Recovery keeps its sweep by the run's label for a run whose reaper is gone, as a backstop for a reaper that was killed (for example at a restart of the engine). Ryuk has no backstop. The maintainers chose to keep one.
10. **The image of the reaper.** The reaper uses an official `docker` CLI image, pinned by version (the probe used `docker:27-cli`), with the script in the command. The package builds no image.

## Not covered by the probe

- A create that the engine finishes after the first pass. In 30 runs, the re-check passes never removed an object.
- Networks and images. The testbed does not create them now.
- Rootless engines: their socket is not `/var/run/docker.sock`.
- Several clients on one reaper.
- A machine that goes away without closing its connection. The engine sees the end of the attach only when the TCP connection ends. On an SSH engine, `ClientAliveInterval` of `sshd` is 0 by default, and TCP keep-alive takes about 2 h (#2843).
- A holder that is killed between the create and the start of its reaper. The reaper stays `created` and never runs. The process created nothing yet, so only the reaper stays. ADR 0014 item 5 has the same case for a sweep lease.
- BigQuery datasets (#2843). They are not engine objects, and a reaper needs credentials for them.

## Considered Options

- **Keep ADR 0006 and make the budgets inputs** (an environment variable, or the query of the setup URL of [ADR 0018](./0018-a-preload-is-a-file-of-the-package-and-its-url-gives-its-settings.md)). The tests get shorter, but the test process still waits for the engine, and the budget still exists in the teardown.
- **Ryuk itself** (`testcontainers/ryuk`). Its session is a TCP port that the client must reach. On an SSH engine, the client reaches only the engine's socket. It also removes no databases inside a server.
- **A reaper held by a TCP port of our own.** Same problem as Ryuk on an SSH engine.
- **A reaper that removes everything, also the local records.** It runs on the engine's host, so it cannot reach the machine of the test process.
- **Derive the teardown budget from the engine call budget.** It keeps both waits.

## Consequences

- No test process and no global teardown waits for the engine to remove the run's objects. A run ends when its last test process ends.
- A killed test process loses its engine objects about 2 s after the kill, not at the end of the run or at the next run.
- Each engine runs one more small container while a run uses it. The image is pulled once on each engine.
- A container with the engine's socket mounted has the rights of the engine on its host. A user who can reach the engine has these rights already.
- `CONTEXT.md` gets the term **Reaper**, and loses **Creating record** when the re-check passes replace it. "Ryuk session" stays an Avoid term.
- The README section "A killed run" changes: the 240 s and the 250 s go, and the reaper's own defaults come in.
- The tests of the reaper run with short values. The two tests of #4205 (251 s and 244 s) go away.
