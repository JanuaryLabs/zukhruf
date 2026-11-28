# A proxy is a handler that a server serves, and it forwards each connection to its upstream

Status: Accepted 2026-11-28 (backlog #6078). Ezz approved the paper of 028f631b as written.

Decision-makers: Ezz, on 2026-11-28, for the shape. The record says: "class Proxy(upstream) is a handler that a Server serves; ... forwarding through node:stream/promises pipeline". The zukhruf session of backlog #6078 proposes the rest from the leaders and the probes below. The type of the upstream, the place of the clock, and the name of the handler are in the "Open for the review" list of the README.

Toxiproxy's proxy does three jobs: it listens, it forwards each connection to its upstream, and it keeps its connections ([proxy.go](https://github.com/Shopify/toxiproxy/blob/main/proxy.go)). In zukhruf the first and the third are the work of a `Serving` of `@zukhruf/net`. Thus the proxy does only the second job: it is the handler of a `Server`.

## Decision

1. `new Proxy(upstream, { clock })` says where to forward. `upstream` is a host and a port. `clock` is required: the toxics wait (a latency, a timeout, a delay), and root ADR 0004 asks each library that waits to take its clock as an input. Each toxic waits on the clock of its proxy.
2. `proxy.forward` is a `Handler` of `@zukhruf/net`. A caller serves it: `await new Server(proxy.forward, { allowHalfOpen: true }).serve(new TcpEndpoint())`. `allowHalfOpen` lets a client's end reach the upstream as an end, not as a close, as testing's `slowProxy` needs.
3. For each accepted socket, the proxy connects to the upstream. When the connect fails, it destroys the accepted socket, as Toxiproxy closes the client when its dial fails ([proxy.go, about lines 207-214](https://github.com/Shopify/toxiproxy/blob/main/proxy.go)).
4. Each direction of a connection is one `pipeline` of `node:stream/promises`: the chunks of the socket that sends, through the toxics of that direction ([ADR 0004](./0004-a-toxic-is-a-strategy-for-one-stream-of-each-connection-and-add-gives-a-disposable.md)), into the socket that receives. The direction from the client is `upstream`, and the direction from the server is `downstream`, as in Toxiproxy.
5. The proxy reads the socket that sends through an async generator, not as a stream of the pipeline. Thus an error of that socket reaches the toxics as a throw of their input, and does not destroy the socket that receives. A toxic decides what an error does: with no toxic, the proxy destroys the other socket. `Vanish` keeps it open.
6. The proxy owns the sockets that it opened to the upstream. `[Symbol.asyncDispose]()` destroys each one and waits for its `close`. A caller declares the proxy before the serving, so `await using` disposes the serving first and the proxy last.

## Considered Options

- **A static `Proxy.to(upstream)` that listens, after Toxiproxy's `CreateProxy`.** The step 2 draft had it. Ezz refused statics on 2026-11-28, and the listen is the work of `@zukhruf/net`.
- **A proxy that is a `Server`.** It would copy the listen and the tracking of `@zukhruf/net`, and it could not serve a `PipeEndpoint` without a second constructor.
- **The socket that sends as the first stream of the pipeline.** Probe of 2026-11-28 (Node 26.13.1): when that socket fails, `pipeline` destroys the socket that receives, also when the toxic catches the error and holds. A gateway for a machine that is gone (`Vanish`, mutex ADR 0035) must keep it open.
- **`pipe()` and `data` listeners, as each copy does today.** Each copy then writes its own back pressure and its own order of the end and the close; `pipeline` does both.
- **A handler that forwards through `pipeline`, with the socket read by a generator.** This option was selected.

## Consequences

- A call site has three lines: the proxy, the serving, and each toxic.
- The upstream sockets that a `Vanish` keeps open stay open until the disposal of the proxy, as `vanishingHop` keeps them until its disposal.

## Confirmation

- Probe of 2026-11-28 (Node 26.13.1, `probe4.mjs` and `probe5.mjs` in the session's scratch folder): `pipeline(source, hold, destination)`, with a `hold` stage that catches its error and waits forever: an end of `source` leaves `destination` open; an error of `source` destroys `destination`. `pipeline(async function* () { yield* source; }, hold, destination)`: the error of `source` reaches `hold` as a throw, and `destination` stays open.
- `allowHalfOpen` set on the accepted socket in the handler works: a server that sets it answers after the client's end (probe of 2026-11-28).
