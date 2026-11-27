# events() opens its stream at the engine clock before the request, so it loses no event after it resolves

Status: Proposed 2026-11-27 (backlog #6085).

Decision-makers: the zukhruf session of the Docker events survey (2026-11-27), from the Moby source, the probes and the top performers in Confirmation. Ezz chose that this API comes before the other work on events, and that the reaper rebuild and the other repositories move onto it ("Primitive first", 2026-11-27).

A wait for a fact of the engine, such as the removal of a container or the end of an exec, can wait for the event of that fact. Today `docker.events()` is an async generator. It sends `GET /events` at the first `next()`, and it takes `since` from the caller. Four facts make such a wait lose events:

- The engine sends the `200` and the headers of `GET /events` before it adds the subscription (`getEvents` in [system_routes.go](https://github.com/moby/moby/blob/master/daemon/server/router/system/system_routes.go): `WriteHeader`, `Flush`, then `SubscribeToEvents`). Thus the headers do not tell that the subscription is in place, and an event between the two is lost.
- With `since`, the engine gives the past events from its buffer, then the live ones. It takes both under the lock with which it publishes, so no event falls between them (`SubscribeTopic` and `PublishMessage` take `e.mu` in [events.go](https://github.com/moby/moby/blob/master/daemon/events/events.go)). The buffer holds the last 256 events of the engine (`eventsLimit`).
- `since` is on the engine clock. 9 callers in zukhruf take it from the clock of this process, as `Math.floor(Date.now() / 1000) - 1` (the list is in backlog #6085). When the engine clock is behind the clock of this process by more than 1 s, a stream that opens after the act misses the event, and the wait runs until the test limit.
- 8 callers in zukhruf write the same loop to wait for one event, and april polls `inspect()` for the health of a container because a stream misses a change that already happened (#2766).

## Decision

`events()` opens the stream before it resolves, at an instant of the engine clock that comes before its request:

1. Without `since`, `events()` reads the engine clock first: `SystemTime` of `GET /info`. Then it sends `GET /events` with that instant as `since`, and it resolves with an `Events` when the headers come. Each event from that instant on comes: the buffer gives the events before the subscription, and the stream gives the others. With `since`, it uses the instant of the caller and reads no clock.
2. `Events` is an async iterable of the events and an async disposable. Its disposal closes its connection. `events.since` is the instant at which the stream starts.
3. `events.first(condition)` resolves with the first event for which `condition` gives `true`. The stream stays open, so the next `first()` reads on from that event. When the engine ends the stream first, `first()` rejects with `EventsEndedError`. An abort of the signal rejects it with the reason of the signal, a lost connection with the error of Node ([ADR 0011](./0011-only-a-failure-before-the-answer-is-a-connection-failure.md)), and an error that `condition` throws with that error.
4. `events()` and `container.wait()` take `ref`. With `ref: false`, the request does not keep the process running, as for `attach()` and `spawn()`.

The order for a caller is: open the events, then act or check the state once, then call `first()`. A fact before the open is in the state that the check reads, and the stream gives each fact after the open.

## Considered Options

- **Keep the lazy generator, and tell the caller to take `since` first.** The 9 callers that take `since` from the clock of this process show that a caller does not get it right. The package can read the engine clock, and the caller needs a request of its own for it.
- **`since` from the clock of this process, as `docker events --since 10m` does** ([events.go of docker/cli](https://github.com/docker/cli/blob/eaae503a22566c7760c0b28df92cfdef36428379/cli/command/system/events.go); `buildEventsQueryParams` of the [Go client](https://github.com/moby/moby/blob/master/client/system_events.go) takes `time.Now()`). It misses events on an engine whose clock is behind.
- **`since` from the `Date` header of `GET /_ping`.** It costs 2.6 ms against 11.5 ms for `GET /info` (Consequences). The header has whole seconds only, so the stream also gives up to 1 s of events from before the open, and a condition on a label can take one of them for the event that it waits for.
- **No `since`.** The headers come before the subscription, so an event right after the open can be lost.
- **A sentinel event that proves the subscription.** The engine joins the filters of different keys with AND, so a sentinel cannot pass most filters.
- **`container.wait()` for each wait, as the Docker engine lock store of mutex does** ([mutex ADR 0026](../../../mutex/docs/adr/0026-a-docker-engine-key-is-a-named-container-that-lives-while-its-holder-attaches.md)). It has no gap: the engine adds the wait before it sends the headers (`postContainersWait` in [container_routes.go](https://github.com/moby/moby/blob/master/daemon/server/router/container/container_routes.go) calls `ContainerWait`, then flushes). But it covers one container and three conditions: not the end of an exec, the health, a volume, a set of containers by label, or a container that does not exist yet. The store keeps it.
- **One stream for each client, shared by each wait, as a SharedInformer of Kubernetes.** It would let `spawn()` wait for `exec_die` with no connection for each exec. No caller needs it now. Add it when a measurement shows the gain.
- **`until()` as the name of `first()`, after `Until` of Kubernetes.** `until` is already a parameter of `GET /events` with another meaning: the end of the stream. RxJS gives `first` the same end as here: an error when the source completes with no match. The `find` of the TC39 proposal for async iterator helpers gives `undefined` at the end, and Node 26.13.1 does not have it.

## Consequences

- An open without `since` sends one more request. On Docker Desktop 29.9.3 at a load average of 26, `GET /info` took 11.5 ms on average and `GET /_ping` 2.6 ms (6 alternating runs, 2026-11-27).
- The 16 calls of `events()` in zukhruf and the 1 in deepagents change: `await` the call, then iterate or call `first()`.
- The 9 callers that take `since` from the clock of this process drop it.
- The README no longer says that a stream misses a change that already happened. april moves from its `inspect()` poll to `first()` (#2766).
- The mutex docs that say an event stream loses a release (docs/stores/docker-engine-store.md:106, :222, :264) say why the store keeps `wait()`: one container, and no clock to read.
- A `since` that the caller gives from long ago is still limited by the buffer of 256 events.

## Confirmation

The red and green tests and their commit come with the build. The evidence so far:

- Moby master: `getEvents` flushes the headers before `SubscribeToEvents`. `SubscribeTopic` and `PublishMessage` take `e.mu`. `eventsLimit = 256`. A subscriber whose buffer of 1024 stays full for 100 ms loses events (`pubsub.NewPublisher(100*time.Millisecond, bufferSize)`). `postContainersWait` calls `ContainerWait` before it flushes the headers.
- Probes on Docker Desktop 29.9.3, API 1.56 (2026-11-27):
  - A `since` from `SystemTime`, with a fraction, gives `health_status: healthy` after the fact, and `event=health_status` matches it.
  - `exec_die` carries `execID` and `exitCode`, and an `exec_*` Action carries the command (`exec_create: sh -c exit 7`).
  - A `label` filter matches the `exec_*` events of a container.
  - The engine joins two `container=` values with OR, and a name filter matches the `create` and `start` of a container that is created later.
  - A volume `destroy` has the name in `Actor.ID` and no labels.
- Top performers:
  - [Kubernetes client-go](https://github.com/kubernetes/client-go/blob/master/tools/watch/until.go): `Until(ctx, initialResourceVersion, …)` (:107) waits from a cursor of the server, and `UntilWithoutRetry` (:56) returns `ErrWatchClosed` (:43) when the watch closes first.
  - [RxJS](https://github.com/ReactiveX/rxjs/blob/7.x/src/internal/operators/first.ts): `first(predicate)` (:82-91) errors with `EmptyError` when the source completes with no match.
  - The [Go client of Moby](https://github.com/moby/moby/blob/master/client/system_events.go): `Events` (:32-84) returns after the headers come.
  - [Docker.DotNet](https://github.com/dotnet/Docker.DotNet/blob/master/src/Docker.DotNet/Endpoints/SystemOperations.cs): `MonitorEventsAsync` (:45) resolves with the stream.
