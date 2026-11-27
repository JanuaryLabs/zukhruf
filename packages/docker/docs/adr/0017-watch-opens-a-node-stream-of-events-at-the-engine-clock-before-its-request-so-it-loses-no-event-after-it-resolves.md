# watch() opens a Node stream of events at the engine clock before its request, so it loses no event after it resolves

Status: Proposed 2026-11-27 (backlog #6085).

Decision-makers: the zukhruf session of the Docker events survey (2026-11-27), from the Moby source, the probes and the top performers in Confirmation. Ezz decided three splits on the first paper (2026-11-27):

- That this API comes before the other work on events, and that the reaper rebuild and the other repositories move onto it: "Primitive first".
- That `events()` stays, and a second method opens the stream at once: "Add a second method".
- That the stream is a primitive of Node, and the package builds no operators of its own: _"I'd rather make use of node native stream primitives for this instead of building our own operators. maybe we build as last resort. this also force the design to be composable and extensible"_.

He also ruled that the needs of a consumer do not shape the package: _"we should force the consumer into the design package not the other way around"_.

A wait for a fact of the engine, such as the removal of a container or the end of an exec, can wait for the event of that fact. Today `docker.events()` is an async generator. It sends `GET /events` at the first `next()`, and it takes `since` from the caller. Four facts make such a wait lose events:

- The engine sends the `200` and the headers of `GET /events` before it adds the subscription (`getEvents` in [system_routes.go](https://github.com/moby/moby/blob/master/daemon/server/router/system/system_routes.go): `WriteHeader`, `Flush`, then `SubscribeToEvents`). Thus the headers do not tell that the subscription is in place, and an event between the two is lost.
- With `since`, the engine gives the past events from its buffer, then the live ones. It takes both under the lock with which it publishes, so no event falls between them (`SubscribeTopic` and `PublishMessage` take `e.mu` in [events.go](https://github.com/moby/moby/blob/master/daemon/events/events.go)). The buffer holds the last 256 events of the engine (`eventsLimit`).
- `since` is on the engine clock. 9 callers in zukhruf take it from the clock of this process, as `Math.floor(Date.now() / 1000) - 1` (the list is in backlog #6085). When the engine clock is behind the clock of this process by more than 1 s, a stream that opens after the act misses the event, and the wait runs until the test limit.
- 8 callers in zukhruf write the same loop to wait for one event, and april polls `inspect()` for the health of a container because a stream misses a change that already happened (#2766).

## Decision

`docker.watch()` opens a stream of the events before it resolves, at an instant of the engine clock that comes before its request:

1. Without `since`, `watch()` reads the engine clock first: `SystemTime` of `GET /info`. Then it sends `GET /events` with that instant as `since`, and it resolves when the headers come. Each event from that instant on comes: the buffer gives the events before the subscription, and the stream gives the others. With `since`, it uses the instant of the caller and reads no clock.
2. It resolves with a `Readable` of Node in object mode. Each chunk is one `EventMessage`. The package adds no operators: a caller waits with the operators of Node, such as `find()`, `filter()`, `take()` and `toArray()`, iterates, or pipes the stream.
3. The signal of `watch()` destroys the stream with the reason of the signal. When the engine ends its answer, the stream ends. When the connection is lost, the stream is destroyed with the error of Node ([ADR 0011](./0011-only-a-failure-before-the-answer-is-a-connection-failure.md)). A disposal of the stream, or of the client, closes its connection.
4. `events()` stays as it is.

The order for a caller is: open the stream, then act or check the state once, then wait on the stream. A fact before the open is in the state that the check reads, and the stream gives each fact after the open.

## Considered Options

- **`events()` opens at once, in place of a second method.** Ezz chose a second method, and `events()` stays.
- **`first(condition)` and `EventsEndedError` of the package, after `first` of RxJS.** Ezz ruled that the package uses the primitives of Node, and builds an operator only when Node has none. `find()` of Node does the job of `first()`, and gives `undefined` at the end of the stream in place of an error.
- **`ref` on `watch()` and `container.wait()`.** The reason for it was a consumer: the `closed()` wait of the reaper of `@zukhruf/testing`. By the ruling of Ezz, the consumer follows the package. The reaper rebuild (#5855) decides `closed()` with the package as it is, and names a gap of the package with a precedent of its domain if one remains.
- **Keep only the lazy generator, and tell the caller to take `since` first.** The 9 callers that take `since` from the clock of this process show that a caller does not get it right. The package can read the engine clock, and the caller needs a request of its own for it.
- **`since` from the clock of this process, as `docker events --since 10m` does** ([events.go of docker/cli](https://github.com/docker/cli/blob/eaae503a22566c7760c0b28df92cfdef36428379/cli/command/system/events.go); `buildEventsQueryParams` of the [Go client](https://github.com/moby/moby/blob/master/client/system_events.go) takes `time.Now()`). It misses events on an engine whose clock is behind.
- **`since` from the `Date` header of `GET /_ping`.** It costs 2.6 ms against 11.5 ms for `GET /info` (Consequences). The header has whole seconds only, so the stream also gives up to 1 s of events from before the open, and a condition on a label can take one of them for the event that it waits for.
- **No `since`.** The headers come before the subscription, so an event right after the open can be lost.
- **A sentinel event that proves the subscription.** The engine joins the filters of different keys with AND, so a sentinel cannot pass most filters.
- **`container.wait()` for each wait, as the Docker engine lock store of mutex does** ([mutex ADR 0026](../../../mutex/docs/adr/0026-a-docker-engine-key-is-a-named-container-that-lives-while-its-holder-attaches.md)). It has no gap: the engine adds the wait before it sends the headers (`postContainersWait` in [container_routes.go](https://github.com/moby/moby/blob/master/daemon/server/router/container/container_routes.go) calls `ContainerWait`, then flushes). But it covers one container and three conditions: not the end of an exec, the health, a volume, a set of containers by label, or a container that does not exist yet. The store keeps it.
- **An async iterable in place of a `Readable`.** Its type would carry `EventMessage`, but Node 26.13.1 has no operators on async iterators (the TC39 proposal for async iterator helpers), so each caller would write its own loop again.
- **One stream for each client, shared by each wait, as a SharedInformer of Kubernetes.** It would let `spawn()` wait for `exec_die` with no connection for each exec. No caller needs it now. Add it when a measurement shows the gain.

## Consequences

- An open without `since` sends one more request. On Docker Desktop 29.9.3 at a load average of 26, `GET /info` took 11.5 ms on average and `GET /_ping` 2.6 ms (6 alternating runs, 2026-11-27).
- `find()` destroys the stream after its match. A wait for two events in order reads them with `take(2).toArray()` or with `iterator({ destroyOnReturn: false })`.
- The `signal` of an operator, such as `find(fn, { signal })`, does not end a stream that gives no event: in Node 26.13.1 the operator stayed pending after the abort. Thus the signal goes to `watch()`, which destroys the stream.
- The operators of `@types/node` 26.6.6 type each chunk as `any`, so a caller names the type of the parameter: `(event: EngineApi.EventMessage) => …`.
- The 9 callers that take `since` from the clock of this process, and the 8 hand-written waits, move to `watch()`. april moves from its `inspect()` poll to `watch()` (#2766).
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
- Probes on Node 26.13.1 (2026-11-27): `Readable` has `find`, `filter`, `map`, `take`, `drop`, `toArray`, `some`, `every`, `forEach`, `reduce`, `flatMap`, `compose` and `Symbol.asyncDispose`. `find()` destroys the stream after a match, and a second `find()` rejects with `ABORT_ERR`. `find()` gives `undefined` at the end of the stream. `iterator({ destroyOnReturn: false })` reads on after a match. `find(fn, { signal })` stays pending after the abort on a stream that gives nothing; `addAbortSignal()` rejects it with `AbortError`.
- Top performers:
  - [Kubernetes client-go](https://github.com/kubernetes/client-go/blob/master/tools/watch/until.go): `Until(ctx, initialResourceVersion, …)` (:107) waits from a cursor of the server. A watch of Kubernetes starts at a `resourceVersion` of the server, never at the clock of the client.
  - The [Go client of Moby](https://github.com/moby/moby/blob/master/client/system_events.go): `Events` (:32-84) returns after the headers come.
  - [Docker.DotNet](https://github.com/dotnet/Docker.DotNet/blob/master/src/Docker.DotNet/Endpoints/SystemOperations.cs): `MonitorEventsAsync` (:45) resolves with the stream.
  - Node: `fs.watch()` gives a stream of changes, and `stream.Readable` gives the operators.
