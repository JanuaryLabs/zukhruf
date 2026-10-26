# DockerEngineStore

A network lock store that uses a container on one Docker engine as the lock. Each process on each machine that reaches the engine shares the locks. The engine reserves a container name for one container only, so the container of a key is its lock. The container lives only while the attach of its holder lasts.

| Reach   | Order                                                                                                              | Holder stops                  | Token source                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------- |
| Network | First come, first served in one process; no order between processes: the first create after a release gets the key | Released when its attach ends | The higher of the engine time and a ladder of named volumes |

## What

Each held key has one **claim**: a container whose name the store makes from the key. The claim runs `cat`, and its holder attaches to the standard input of `cat`. While the attach lasts, `cat` waits for input. When the attach ends, `cat` reads the end of its input and exits, and the engine removes the claim. To release the key, the holder removes its claim. The store uses `@zukhruf/docker` and does not connect by itself. You give it a `Docker` client, and the store sends each request through that client ([ADR 0022](../adr/0022-a-database-lock-store-takes-its-session-from-the-caller.md) has the same rule for a database).

```ts
import { Docker } from '@zukhruf/docker';
import { Mutex } from '@zukhruf/mutex';
import { DockerEngineStore } from '@zukhruf/mutex/docker';

await using docker = await Docker.connect({ environment: process.env });

const mutex = new Mutex(
  new DockerEngineStore({
    docker,
    image: 'alpine:3',
    namespace: 'ci-cleanup',
    heartbeatInterval: 5_000,
  }),
);
```

## Why

Some machines share no database, but they share one Docker engine. For example, test runs on many CI machines start their containers on one engine over SSH, and a cleanup of these containers must run one at a time. The lock must be where the shared thing is. The Docker engine already has the three parts of a lock: it gives a name to one container only, it ends a container when its input ends, and it tells a caller when a container is removed. Thus no caller must find or remove a holder that stopped, and no other server is necessary. See [ADR 0021](../adr/0021-a-lock-store-can-reach-every-machine-that-reaches-one-server.md) and [ADR 0026](../adr/0026-a-docker-engine-key-is-a-named-container-that-lives-while-its-holder-attaches.md).

## When

- Processes on more than one machine write to a thing that one Docker engine has, for example its containers or volumes.
- These processes already reach that engine through `@zukhruf/docker`.
- Holder processes can crash, and you want no manual cleanup.

## When not

- All callers are on one host. A [host lock store](../concepts/reach.md) needs no engine and no round trip.
- The callers share a Postgres database. [PostgresStore](./postgres-store.md) grants a key in one round trip. This store needs approximately six round trips for each grant, and over SSH a grant takes approximately 1 second (see [Evidence](#evidence)).
- Waiters must get the key in the order in which they asked. Between processes, this store has no order.

## How it works

**The names of a key.** A container name accepts only `[a-zA-Z0-9][a-zA-Z0-9_.-]*`, but a key can be any text. Thus the store calculates the SHA-256 digest of the UTF-16 code units of the key, as `PostgresStore` does, and writes it as 64 hexadecimal digits. The claim is `<namespace>-<digest>`. The rung `n` of the token ladder is the volume `<namespace>-<digest>-token-<n>`. Each claim has the labels `zukhruf.mutex.namespace` and `zukhruf.mutex.key`, with the key as text. Each rung has the labels `zukhruf.mutex.namespace` and `zukhruf.mutex.token`, with the digest. Each claim and each rung also has the labels of the `labels` option. The store writes its own labels after them, so the caller cannot change them ([ADR 0029](../adr/0029-a-docker-engine-store-marks-its-claims-and-rungs-with-the-labels-of-the-caller.md)). The engine accepted a name of 90 characters for a container and for a volume.

**The claim.** The store creates the claim with this body:

```ts
{
  Image: options.image,
  Entrypoint: ['cat'],
  Cmd: [],
  OpenStdin: true,
  StdinOnce: true,
  AttachStdin: true,
  Labels: {
    ...options.labels,
    'zukhruf.mutex.namespace': namespace,
    'zukhruf.mutex.key': key,
  },
  HostConfig: { AutoRemove: true },
}
```

Each field has a reason:

- `OpenStdin` and `AttachStdin` give `cat` a standard input that the attach of the holder writes to.
- `StdinOnce` closes the standard input of `cat` when the attach ends. Without it, the input stays open after the holder stops, and `cat` runs forever (see [Evidence](#evidence)).
- `AutoRemove` makes the engine remove the claim when `cat` exits. Without it, the exited claim keeps the name, and nobody gets the key again.
- `Entrypoint: ['cat']` replaces the entrypoint of the image. The image must have `cat` on its `PATH`.
- `Labels` lets a cleanup find the claim by the labels of the caller. A cleanup never trusts a name.

**Acquire.**

1. Callers in one process first line up in a queue in memory, in the order of their calls, as in `PostgresStore`. Only the first caller in that queue continues. Thus one process makes at most one claim attempt for each key.
2. The caller creates the claim with `docker.containers.create(body, { name })`. This call rejects with `NameConflictError` when the name is taken. The store never uses `createOrGet()`, because it gives the container that exists, and a claim must fail when another caller has the name.
3. If the create rejects with `NameConflictError`, the caller waits for the claim of the other caller (see [Waiting](#waiting)). Then it goes back to step 2.
4. If the create succeeds, the caller attaches to the claim with `attach({ stdin: true })`, and then starts it with `start()`. It attaches before the start, so the claim never runs without an attach. If the start rejects because a waiter removed the claim (see [An abandoned claim](#an-abandoned-claim)), the caller goes back to step 2.
5. The caller mints the fencing token (see [The token](#the-token)).
6. The caller confirms the claim: it finds the claim by its ID. If the claim is gone, the caller lost it during the mint, and the token goes to nobody. The caller goes back to step 2.
7. The store makes its own `LeaseController` and starts the [heartbeat](#the-heartbeat).

**Release.** The holder removes its claim by its ID with `remove({ force: true })`. The ID, not the name, so that a release never removes the claim of a later holder. The engine then sends `destroy`, and each waiter of the key continues. Then the next caller in the in-process queue continues.

### Waiting

A waiter must not miss the release. The release can come between the failed create of the waiter and the start of its wait. Thus the waiter waits on the claim that it found, by its ID:

1. The waiter finds the claim by name with `containers.find(name)`. If it gets `undefined`, the claim is gone, and the waiter goes back to the create.
2. The waiter reads the state of the claim with an inspect. If the claim is `running`, `paused`, `restarting` or `removing`, the waiter calls `wait({ condition: 'removed' })` on it, with a time limit of `heartbeatInterval`. The engine answers when the claim is removed. If the claim was removed before the wait arrived, the engine answers 404 at once. In both cases, the waiter goes back to the create.
3. If the wait reaches its time limit, the waiter does step 2 again. The waiter never removes a claim in these states: the claim can have a live holder.
4. If the claim is `exited` or `dead`, it has no holder, but the engine did not remove it (see [An ended claim](#an-ended-claim)). The waiter removes it by its ID, and goes back to the create.

The store does not use `docker.events()` for this. An event stream gives no sign that the engine has added the subscription. A release that comes before the subscription is lost, and the waiter waits forever. A probe showed this on both engines (see [Evidence](#evidence)). A wait by ID has no such gap: the engine answers it at once when the claim is gone.

Each waiter that wakes creates the claim again. One create succeeds. The other waiters get `NameConflictError` and wait again. Thus the key has no order between processes: the first create that the engine receives after the release gets the key. A waiter can wait for a long time if other waiters always create first.

A cancel aborts the signal of the wait. The request closes, and the call rejects with `signal.reason`. A waiter holds no claim, so a cancel removes nothing. If the signal aborts after the create succeeded, the store removes the new claim by its ID.

### An abandoned claim

A caller that stops between the create and the start leaves a claim in the state `created`. Nothing starts it, and the engine never removes it. A waiter that waits for its removal waits forever (see [Evidence](#evidence)).

The waiter cannot tell a stopped caller from a slow one. Thus a waiter that finds a `created` claim waits for its removal for at most `heartbeatInterval`. If the claim with the same ID is still `created` after that time, the waiter removes it with `remove({ force: false })`. The engine does one of these two things, and never both:

- The start of the caller came first. The claim runs, the removal rejects with `ContainerRunningError`, and the waiter waits for a running claim (see [Waiting](#waiting)).
- The removal came first. The claim is gone, and the start of the caller rejects. The caller then goes back to the create.

Thus a slow caller loses only time, never the key to two holders. Over SSH, a create, an attach and a start took 1.0 to 2.9 seconds in the probes. Give a `heartbeatInterval` that is larger than that time, for example 5 seconds.

### An ended claim

`AutoRemove` makes the engine remove the claim when `cat` exits. If that removal fails, the claim stays on the engine in the state `exited` or `dead`. Its name stays taken, and a wait for its removal never ends. `@zukhruf/docker` has the same warning on `remove()`.

Thus a waiter does not wait for the removal of a claim for more than `heartbeatInterval`. Then it reads the state of the claim again. If the claim is `exited` or `dead`, the waiter removes it by its ID, not by its name. A removal by ID never removes a later claim with the same name. If the claim is already gone, the removal succeeds. Then the waiter creates the claim again.

`isHeld` gives `false` for such a claim, and `acquire` gets the key within one `heartbeatInterval`.

### The heartbeat

A holder must know when its claim ends. The attach of the holder tells it in most cases: when `cat` exits, the exit code of the attach resolves, and when the connection ends, it rejects. In both cases, the store aborts the signal of the lease with `LeaseLostError` ([ADR 0013](../adr/0013-a-lost-lease-aborts-the-signal-of-the-lease.md)).

A connection that stops silently tells nothing. Thus the holder also inspects its claim by ID each `heartbeatInterval` milliseconds, with a time limit of `heartbeatInterval`. If the claim is gone, if it does not run, if the inspect fails, or if no answer arrives in time, the lease is lost. The store then removes its claim by ID, so that a claim that still runs does not keep the waiters waiting. A late inspect acquires nothing, so a heartbeat that timed out leaves nothing behind.

The heartbeat asks the engine about the claim, not about the connection. The claim is the lock. While the engine shows the claim as running, no other caller can get the key, also when the attach connection is slow.

`heartbeatInterval` is the longest time that a holder can work after its claim ended, before its signal aborts. Until then, only the [fencing token](../concepts/fencing-tokens.md) protects the resource.

### The token

The Docker engine has no counter. Thus the tokens come from a ladder of named volumes, one rung for each grant. The engine gives a volume name to one volume only, as it does for a container name. This is the rule of the Delta Lake transaction log: each commit writes the file of the next version, and the storage refuses a second file with the same version ("mutual exclusion": put-if-absent, [Delta Lake protocol](https://github.com/delta-io/delta/blob/master/PROTOCOL.md)). See [ADR 0027](../adr/0027-docker-engine-tokens-come-from-a-ladder-of-named-volumes.md).

The engine can lose the ladder, for example after `docker volume prune -a` or a wipe of the engine. Then a ladder alone starts again at 1, and a fenced resource accepts the writes of a stale holder with the highest old token. Thus the lowest token that a mint gives is the engine time: the `Created` time of the claim, in microseconds since 1970. This is a hybrid logical clock (Kulkarni et al., OPODIS 2014). See [ADR 0028](../adr/0028-a-docker-engine-token-is-the-higher-of-the-engine-time-and-the-ladder.md).

To mint a token, the holder:

1. Sends two requests at the same time:
   - An inspect of its claim by ID. It reads `Created`, the time at which the engine created the claim, and converts it to microseconds since 1970. If the claim is gone, the mint stops, and the caller goes back to step 2 of [Acquire](#how-it-works).
   - A list of the rungs of the key with two label filters, `zukhruf.mutex.namespace=<namespace>` and `zukhruf.mutex.token=<digest>`. It reads the highest number `n`. With no rung, `n` is 0. The namespace filter is necessary: one key in two namespaces has one digest, and step 3 removes each rung that the list gives.
2. Creates the volume of the rung with the higher of the time and `n + 1`, with `docker.volumes.create()`. If it rejects with `NameConflictError`, the holder tries the next number, and so on.
3. Removes the rungs that it listed in step 1. Thus each key keeps one rung. A rung is removed only after a higher rung exists, so a list always finds the highest rung.

The number of the new rung is the token. While the ladder is there, `n + 1` keeps the tokens in order, also when the clock of the engine goes back. When the ladder is gone, the time of a later claim is higher than each earlier token. The tokens can fail to increase only after two faults at the same time: the ladder is gone, and the clock of the engine is behind the highest earlier token.

The engine sets `Created`, so each client of one engine reads one clock, locally and over SSH. `Created` has a precision of nanoseconds. A time in microseconds is approximately 2^51, so it fits a signed 64-bit integer and a safe integer of JavaScript. The `CreatedAt` time of a volume has a precision of seconds only, so the store does not use it.

Each mint is followed by the confirmation of the claim (step 6 of [Acquire](#how-it-works)). Without that confirmation, a stale holder that read the ladder before it lost its claim can climb above the token of the next holder. A probe showed this: the next holder got 1, and the stale holder got 2 (see [Evidence](#evidence)). With the confirmation, the stale holder finds its claim gone and uses no token.

The ladder uses volumes, not containers. `docker container prune` removes each container that does not run, also a container in the state `created`. A ladder of created containers would go back to 1 after each prune. `docker volume prune` keeps named volumes, and only `docker volume prune -a` removes them.

## Acquire modes

`tryAcquire` gives up at once if another caller in this process holds or waits for the key. Otherwise it creates the claim once. If the create rejects with `NameConflictError`, it gives up, also when the claim is abandoned: only a waiter removes an abandoned claim. If the create succeeds, it attaches, starts, mints and confirms as `acquire` does. A failed start or a failed confirmation gives up. A waiter that gives up aborts its wait or leaves the in-process queue. See [acquire modes](../concepts/acquire-modes.md).

## Holder check

`isHeld(key)` finds the claim by name with `containers.find(name)` and reads its state. It never creates a container and never mints a token, so it never makes a key busy ([ADR 0015](../adr/0015-a-holder-check-never-acquires-the-key.md)).

- No claim: `false`.
- `created`, `running`, `paused` or `restarting`: `true`. A `created` claim is a caller in the middle of an acquire, or an abandoned claim. No other caller can get the key while it exists.
- `exited`, `dead` or `removing`: `false`. The engine removes such a claim soon. If the removal of the engine fails, a waiter removes it (see [An ended claim](#an-ended-claim)).

The holder can change before the answer arrives. Show the answer, but do not acquire a key because of it.

## Failure modes

- **A holder process stops:** its kernel closes the connection of the attach. `cat` reads the end of its input and exits, and the engine removes the claim. The next waiter gets the key. Over SSH, the `ssh` process of the attach reads the end of its input and closes the remote side. The claim was removed 75 to 87 ms after a `SIGKILL` on Docker Desktop, and 239 to 260 ms after it over SSH.
- **The attach ends while the holder runs:** the claim exits and the engine removes it, so another caller can get the key. The attach rejects or its exit code resolves, and the store aborts the signal of the lease with `LeaseLostError`.
- **The engine restarts:** each attach ends, so each claim ends and each holder gets a lost lease. The volumes of the ladder stay, and the engine time continues, so the tokens continue to increase.
- **A silent partition between the holder and the engine:** nothing reaches the engine, so `cat` continues to run and the key stays held. The [heartbeat](#the-heartbeat) of the holder fails within `heartbeatInterval`, and the signal of the lease aborts. The store tries to remove its claim, but the removal also cannot reach the engine. Waiters then wait until the engine host sees the end of the connection: see the next item.
- **A holder machine stops with no reset:** the engine sees the end of the attach only when the connection ends on the engine host. On a Unix socket, the engine and the holder are on one machine, so this case does not occur. Over SSH, `sshd` on the engine host ends the connection after `ClientAliveInterval` × `ClientAliveCountMax` seconds. With `ClientAliveInterval 0`, the default, only TCP keep-alive of the engine host ends it: 7200 + 9 × 75 seconds, approximately 2 hours and 11 minutes, with the Linux defaults. Until then, the key stays held, and waiters wait. Set `ClientAliveInterval` on the engine host, for example `ClientAliveInterval 10` with `ClientAliveCountMax 3`.
- **A waiter behind a silent partition:** its wait by ID ends after `heartbeatInterval`, but its next inspect of the claim does not end. The store sets no time limit on the requests of a waiter. The signal of the caller limits them. Set `ServerAliveInterval` for the engine host in `~/.ssh/config` of the waiter machine, so that `ssh` ends a dead connection within seconds.
- **A caller stops between the create and the start:** its claim stays `created`. A waiter removes it after `heartbeatInterval`. See [An abandoned claim](#an-abandoned-claim).
- **The engine does not remove an ended claim:** the claim stays `exited` or `dead`. A waiter removes it within `heartbeatInterval`. See [An ended claim](#an-ended-claim).
- **A holder freezes:** waiters wait while the attach lasts. If the connection ends meanwhile, another holder can get the key. The frozen holder sees the lost lease only when it runs again. A [fenced resource](../concepts/fencing-tokens.md) refuses its late writes.
- **Somebody removes a claim:** for example `docker rm -f` or `docker container prune`. Another caller can get the key at once. The attach of the holder ends, and the holder gets a lost lease.
- **Somebody removes the ladder:** for example `docker volume prune -a`, `docker system prune -a --volumes`, a wipe of the engine, or a cleanup by the labels of the caller. The next token is the engine time, which is higher than each earlier token. A fenced resource thus accepts the writes of the next holder and refuses the writes of a stale holder. This is not true if the clock of the engine is also behind the highest earlier token at that time. See [The token](#the-token).
- **The clock of the engine goes back:** the ladder keeps the tokens in order, because each token is at least the highest rung + 1.
- **The image is not on the engine:** the create rejects with `ImageNotFoundError`, and the call rejects. The store never pulls an image. Pull it before the app starts.
- **The image has no `cat`:** the start fails, and the call rejects.
- **Other software uses the same names:** two stores with the same `namespace` on one engine share their locks. That is the purpose of `namespace`. Do not give other containers or volumes names that start with it.
- **The Docker client is disposed:** each attach ends, so each holder gets a lost lease.

See [failure modes](../concepts/failure-modes.md).

## Options

| Option              | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docker`            | —       | A `Docker` client of `@zukhruf/docker`. It selects the engine. The caller owns it and disposes of it; a disposal ends each attach, and each held key is lost.                                                                                                                                                                                                                                                            |
| `image`             | —       | The image of each claim. It must be on the engine, and it must have `cat` on its `PATH`. The store never pulls it. A small image, for example `alpine:3` (8.4 MB), is enough.                                                                                                                                                                                                                                            |
| `namespace`         | —       | The first part of each name and the value of the label `zukhruf.mutex.namespace`. Stores with the same namespace on one engine share their locks. It must match `[a-zA-Z0-9][a-zA-Z0-9_.-]*`.                                                                                                                                                                                                                            |
| `heartbeatInterval` | —       | Milliseconds between two heartbeats of a holder, and the time limit of each heartbeat. It is also the time that a waiter gives a `created` claim before it removes it, and the time between two looks of a waiter at the claim. Make it larger than a create, an attach and a start: over SSH, 5 seconds or more.                                                                                                        |
| `labels`            | `{}`    | Labels that the store puts on each claim and each rung, so that a cleanup or an operator can find them. The labels `zukhruf.mutex.namespace`, `zukhruf.mutex.key` and `zukhruf.mutex.token` of the store replace labels with the same names. A test run gives `new DockerFixtures({ environment: process.env }).defaults.labels` of `@zukhruf/testing`, so that its run cleanup removes what a killed test process left. |

The first four options are required. `labels` is optional.

## Changes this design forces in other packages

1. **`@zukhruf/docker`: `start()` of a container whose removal is in progress rejects with `ContainerNotFoundError`.** The engine answers such a start with 409 `container is marked for removal and cannot be started`. Before this change, `start()` rejected with a plain `DockerEngineError`. Now `start()` inspects the container after a 409. If the container is gone or in the state `removing`, `start()` rejects with `ContainerNotFoundError`. A start after the removal ends gets 404 and `ContainerNotFoundError`, as before. The test `start() that races a removal without force runs the container or is a ContainerNotFoundError with its ID` in `packages/docker/src/containers.test.ts` shows it. For the store, the two answers mean one thing: the claim is gone, so create it again. In the probe, a start that raced a removal got the 409 in 19 of 20 runs and the 404 in 1. Without the change, the store must read the status and the text of a `DockerEngineError`. With it, the store catches one class. The package already makes a class for each answer that changes the next step of a caller.

These existing parts of `@zukhruf/docker` stay, because a probe showed that each one is the right tool:

- **`containers.create()`, which rejects with `NameConflictError`.** It is already the create for a lock: it fails and does not join. In 20 rounds of 6 creates at the same time, one create succeeded and 5 rejected in each round, on both engines. `createOrGet()` joins the container that exists, so it cannot claim a key.
- **`attach({ stdin: true })` on the main process.** It ties the life of the claim to the connection: the claim ended 63 to 74 ms after the holder stopped on Docker Desktop, and 221 to 245 ms after it over SSH. A process from `exec()` cannot do this, because the container continues when an exec process ends. A new `tether()` method in `@zukhruf/docker` would add a lock idea to a client that knows no locks. The three fields that make the attach a lock (`StdinOnce`, `AutoRemove`, `Entrypoint: ['cat']`) are in the body that the store creates.
- **`container.inspect()`, which gives `Created`.** `ContainerInspectResponse` already has `Created` as RFC 3339 text with nanoseconds. The mint reads the engine time from it, so `@zukhruf/docker` needs no change for [ADR 0028](../adr/0028-a-docker-engine-token-is-the-higher-of-the-engine-time-and-the-ladder.md).
- **`container.wait({ condition: 'removed' })`.** It has no gap between the check and the wait. `docker.events()` has one, and the store does not use it. A sign that the subscription is in place would remove that gap, but no consumer needs it now.

These changes are not necessary:

- **The `cat` on a stdin pipe in `@zukhruf/testing` (`src/docker/host.ts`).** It ends an `ssh` port forward when the test process stops. The claim ends a container when its attach ends. The two have the same idea, but they use different mechanisms (an `ssh` process and an engine attach) and change for different reasons. They do not share code, so nothing moves to `@zukhruf/docker`.
- **`TestRun` and the run cleanup of `@zukhruf/testing`.** The store does not know them. A test gives the labels of its run through `defaults.labels`, the seam that `@zukhruf/testing` already has for other container APIs, and the run cleanup removes resources by these labels. A create that is in progress when its process stops is a separate gap (backlog #2843).

## Evidence

`src/lock-stores/docker/docker-engine-store.test.ts` has one test for each design error that the probes found. The name of each test says what the wrong design broke. Each test uses a new `namespace` on the local engine. Its disposal removes each container and volume with the label of that namespace. Each store also gets the labels of the test run, so the teardown of the run removes what a killed test process left. A test that must stop a caller at one step uses a Unix socket proxy in front of the socket of the engine. The proxy keeps the requests of that caller from the engine.

| Test                                                                                                        | Wrong design that makes it fail                                                |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A killed holder's key goes to the next waiter                                                               | A claim without `StdinOnce`; a claim without `AutoRemove`                      |
| A waiter wakes when the holder releases between the create of the waiter and its wait                       | A wait with `docker.events()` that subscribes after the failed create          |
| A key whose caller stopped between the create and the start goes to the next waiter after heartbeatInterval | A wait for the removal with no time limit on a `created` claim                 |
| A caller whose claim a waiter removed before the start tries again                                          | A failed start that rejects the acquire                                        |
| A holder that lost its claim during the mint gets no token                                                  | A mint with no confirmation of the claim                                       |
| A held key is lost within heartbeatInterval when the engine stops answering                                 | No heartbeat, only the attach. The proxy stops forwarding and closes no socket |
| The tokens increase after docker container prune                                                            | A ladder of created containers                                                 |
| The tokens increase after the ladder volumes are removed                                                    | A token from the ladder alone                                                  |
| A rung above the engine time still gives a higher token                                                     | A token from the engine time alone                                             |
| A token is the engine time of the claim in microseconds                                                     | A time from `Date.parse`, which keeps milliseconds only                        |
| A waiter gets the key when the released claim stays dead after a failed removal                             | A wait for the removal with no time limit on an `exited` claim                 |

Each wrong design was put back into a copy of the store, one at a time. Each one made its test fail.

The same file also has the tests of the lock store contract: two stores on one engine never run tasks of one key at the same time, a waiter gets the key when the holder releases it, `tryAcquire` gives up on a held key, `isHeld` creates nothing, the tokens of one key increase, a cancelled acquire rejects with the reason of its signal, two namespaces do not share a key or its tokens, each claim and rung carries the labels of the caller, and the labels of the store replace labels of the caller with the same names. One test runs `node --test` with the global setup of the mutex on a test file that kills its own process while it holds a key. After the run, no claim and no rung of that process stays.

`DockerEngineStore` runs in each test of the lock-store matrix (`src/testing/store-cases.ts`) that its reach includes: in one process, across processes, and across threads. Each test gets a new `namespace` on the local engine. A child process or a worker thread connects its own client to the same engine. The tests that read the files of a store do not run, because the store keeps no files.

These facts come from probes with `@zukhruf/docker` (from `packages/docker/dist`) on Node.js 26.10.0, before the design. Each probe used two engines: Docker Desktop 29.8.0 on macOS (API 1.56, a Unix socket, image `node:lts-alpine`), and Docker 28.5.0 on Ubuntu 24.04.4 over SSH (API 1.51, image `alpine:3`). The SSH engine had `ClientAliveInterval 0`, `TCPKeepAlive yes`, and the Linux TCP keep-alive defaults 7200, 75 and 9. The `~/.ssh/config` of the client had `ControlMaster auto` and `ControlPersist 60`.

- **One create gets the name.** 20 rounds of 6 creates with one name at the same time. In each round on each engine, one create succeeded and 5 rejected with `NameConflictError`. A round took 46 ms (median) on Docker Desktop and 175 ms over SSH.
- **The claim ends when the holder stops.** A holder process created, attached and started a claim, and was then killed with `SIGKILL`. `cat` exited 63 to 74 ms later on Docker Desktop and 221 to 245 ms later over SSH. The engine removed the claim 75 to 87 ms and 239 to 260 ms after the kill (3 runs each). No `ssh` process of the holder ran after it.
- **Without `StdinOnce`, the claim runs forever.** After the kill, the claim still ran 18.4 seconds later, on both engines.
- **Without `AutoRemove`, the name stays taken.** `cat` exited 65 ms after the kill, but the claim was still there, `exited`, 18.4 seconds later.
- **A create, an attach and a start.** On Docker Desktop: 20 to 86, 5 to 8, and 44 to 57 ms. Over SSH: 108 to 185, 400 to 542, and 447 to 491 ms. Over SSH with no connection sharing: up to 153, 1491 and 1324 ms.
- **A stopped `ssh` with connection sharing stops nothing.** The 3 `ssh` processes of a holder were stopped with `SIGSTOP`. The attach continued, because each `ssh` process gives its input to the shared master connection. When the holder was killed, the claim was gone within 3 seconds. Thus this probe cannot show a silent partition.
- **A stopped `ssh` with no connection sharing keeps the claim, and the heartbeat finds it.** With `ControlMaster=no`, the 3 `ssh` processes of a holder were stopped with `SIGSTOP`. A heartbeat with an interval of 2000 ms timed out 2.9 seconds later. The claim still ran after 5, 15 and 30 seconds, and also after the holder was killed. After `SIGCONT`, the engine removed the claim 251 ms later. A real partition, with no answers from the kernel, was not tested: it needs a firewall rule on the client machine.
- **A release wakes the next waiter.** A holder removed its claim, and a waiter in `wait({ condition: 'removed' })` created, attached and started the next claim. This took 139 to 233 ms on Docker Desktop (10 runs) and 1072 to 2697 ms over SSH (5 runs).
- **An event stream loses a release.** A waiter got `NameConflictError`, the holder removed its claim, and then the waiter subscribed to `destroy` events with the name filter. No event arrived within 4 seconds, on both engines. A subscription with `since` set to the `Created` time of the claim and the ID filter got the `destroy` event, but the engine keeps only a limited buffer of past events.
- **A wait by ID has no gap.** `wait({ condition: 'removed' })` on a claim that was already removed rejected at once with `ContainerNotFoundError` (404). A wait that raced a forced removal resolved in 60 of 60 runs on Docker Desktop and in 20 of 20 runs over SSH.
- **An abandoned claim stays.** A process created and attached a claim and was killed before the start. 10 seconds later, the claim was still `created`, and a wait for its removal timed out after 5 seconds, on both engines.
- **A start and a removal without `force` never both succeed.** On Docker Desktop, with the removal 0 to 120 ms after the start, the start succeeded and the removal rejected with `ContainerRunningError` in 60 of 60 runs; the claim ran. Over SSH, with 0 to 900 ms, the removal succeeded and the start rejected with `ContainerNotFoundError` in 20 of 20 runs; the claim was gone. On Docker Desktop with no delay, the removal succeeded in 20 of 20 runs, and the start rejected with `DockerEngineError` 409 `container is marked for removal and cannot be started` in 19 runs and with `ContainerNotFoundError` in 1.
- **One create gets a volume name.** 15 rounds of 6 `volumes.create()` with one name at the same time. In each round on each engine, one create succeeded and 5 rejected with `NameConflictError`.
- **The ladder.** 10 mints one after the other gave 1 to 10, and one rung stayed. A mint (list, create, remove) took 3 to 9 ms on Docker Desktop and 220 to 452 ms over SSH. 3 mints at the same time gave 11, 12 and 13.
- **A mint with no confirmation gives a stale holder a higher token.** Holder A read the ladder, and then its claim was removed. Holder B got the claim and minted 1. Then A minted 2. A find of A's claim by its ID gave `undefined`.
- **Prune** (Docker Desktop, with a label filter). `docker volume prune` kept a named volume. `docker container prune` removed a `created` container. `docker volume prune -a` removed the named volume.
