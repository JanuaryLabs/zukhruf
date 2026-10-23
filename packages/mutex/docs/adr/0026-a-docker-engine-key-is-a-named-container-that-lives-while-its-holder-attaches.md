# A Docker engine key is a named container that lives while its holder attaches

Some callers on many machines share one Docker engine, but no database. [ADR 0021](./0021-a-lock-store-can-reach-every-machine-that-reaches-one-server.md) says what a network lock store needs: a lock that the server keeps while the session of the holder lasts, a heartbeat, and tokens from the server. The Docker engine has no lock. Thus `DockerEngineStore` makes one from three things that the engine does:

1. **The claim is a container name.** The engine gives a name to one container only. The store creates a container that it names after the key, with `containers.create()`, which rejects with `NameConflictError` when the name is taken. In probes with 6 creates at the same time, one create succeeded in each of 20 rounds, on Docker Desktop 29.8.0 and on Docker 28.5.0 over SSH.
2. **The session is the attach.** The claim runs `cat` with `OpenStdin`, `StdinOnce` and `AutoRemove`. The holder attaches to the standard input before the start. When the attach ends, `cat` reads the end of its input and exits, and the engine removes the claim. The claim was removed 75 to 87 ms after a `SIGKILL` of the holder on Docker Desktop, and 239 to 260 ms after it over SSH. Without `StdinOnce`, the claim still ran 18 seconds later. Without `AutoRemove`, the exited claim kept the name.
3. **A waiter waits by ID.** After a failed create, the waiter finds the claim and calls `wait({ condition: 'removed' })` on its ID. The engine answers when the claim is removed, and answers 404 at once when it is already gone. Thus a release between the failed create and the wait is never lost.

A holder also sends a heartbeat: an inspect of its claim by ID each `heartbeatInterval`, with a time limit. The heartbeat asks about the claim, not the connection, because the claim is the lock. With no connection sharing, a stopped `ssh` kept the claim running for more than 30 seconds, and a heartbeat of 2000 ms lost the lease 2.9 seconds after the stop.

A caller that stops between the create and the start leaves a claim in the state `created`, and the engine never removes it. A waiter gives such a claim `heartbeatInterval`, and then removes it without `force`. The engine lets only one of two calls succeed: the start of the caller, or the removal. In probes, a lost start rejected with 404 or with 409 `marked for removal`, and a lost removal rejected with `ContainerRunningError`. Thus a slow caller loses only time.

## Considered Options

- **`docker.events()` for the wait.** The notes before the design used it. An event stream gives no sign that the engine has added the subscription. In probes on both engines, a release between the failed create and the subscription was lost: no event arrived within 4 seconds. `since` with the creation time of the claim replays the event, but only from a limited buffer of past events. A wait by ID has no gap and no buffer.
- **A process from `exec()` that holds the input.** The container continues when an exec process ends, so the claim would not end with the holder. The main process must be the one that reads the input.
- **A label or a file with a time of expiry.** Each holder would renew its claim, and a waiter would remove a claim that expired. [ADR 0012](./0012-a-file-store-holder-is-judged-by-its-presence.md) rejected this: a slow holder loses its key while it can still continue. The attach ends only when the connection ends.
- **`createOrGet()` for the claim.** It gives the container that exists, so two callers would both get it.
- **A waiter that starts an abandoned claim.** If the caller stopped before its attach, the claim would run with an open input and no attach, and `cat` would never exit. The removal without `force` has no such case.
- **A separate option for the time that a waiter gives a `created` claim.** It has the same meaning as `heartbeatInterval`: the time that the store gives a silent peer before it acts. A second option would add a value that each caller must select, with no case that needs two values.
- **A `tether()` method in `@zukhruf/docker`.** It would put a lock idea in a client that knows no locks. `attach({ stdin: true })` is enough, and the fields that make it a lock are in the body that the store creates. The `cat` on a stdin pipe in `@zukhruf/testing` ends an `ssh` process, not a container, so it is a different mechanism, and nothing is shared.

## Consequences

- `@zukhruf/mutex/docker` gives `DockerEngineStore`, and `@zukhruf/docker` is its optional peer dependency ([ADR 0020](./0020-each-store-family-has-its-own-import-path.md)). The caller gives the `Docker` client, as a database lock store takes its session from the caller ([ADR 0022](./0022-a-database-lock-store-takes-its-session-from-the-caller.md)).
- The options are `docker`, `image`, `namespace` and `heartbeatInterval`. All are required. The image must be on the engine and must have `cat`.
- A held key uses an attach connection and a wait connection. Over SSH, each one is an `ssh` process. A waiter uses one more connection.
- Between processes, the key has no order. Each waiter creates the claim again after a release, and the first create that the engine receives wins.
- A holder machine that stops with no reset keeps its key until the engine host ends the connection. Over SSH with `ClientAliveInterval 0`, that is TCP keep-alive: approximately 2 hours and 11 minutes with the Linux defaults. The engine host must set `ClientAliveInterval`.
- `@zukhruf/docker` must reject a start of a container whose removal is in progress with `ContainerNotFoundError`, not with a plain `DockerEngineError`. See [DockerEngineStore](../stores/docker-engine-store.md#changes-this-design-forces-in-other-packages).
- The lock-store matrix gets a case for this store with the reach `network`. Its fixture is a new `namespace` on the local engine.
