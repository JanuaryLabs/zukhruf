# @zukhruf/chaos

> **Design for review (backlog #6078).** This is the API on paper. There is no code, and the folder is not a project yet. Each decision is a proposed ADR, and each detail that no record decides is in [Open for the review](#open-for-the-review).

Put faults between a client of a test and a real server. A `Proxy` forwards each connection to its upstream, the real server. A `Server` of `@zukhruf/net` serves it on a free port, and the client connects to that port in place of the server's. `proxy.add(toxic)` puts a fault on one stream of each connection, also of each connection that is open: a latency, a partition, a reset, a stall after a count of bytes, a side that vanishes. The model is [Toxiproxy](https://github.com/Shopify/toxiproxy), in the process of the test ([ADR 0001](./docs/adr/0001-a-tool-package-on-net-holds-the-faults-that-a-proxy-injects-between-a-client-and-a-real-server.md)).

It is a tool package: only tests and tools import it.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install --save-dev @zukhruf/chaos
```

```ts
import { Proxy, Timeout } from '@zukhruf/chaos';
import { Server, TcpEndpoint } from '@zukhruf/net';

await using proxy = new Proxy(
  { host: database.host, port: database.port },
  { clock: globalThis },
);
await using hop = await new Server(proxy.forward, {
  allowHalfOpen: true,
}).serve(new TcpEndpoint());
const client = connectTo({ host: hop.address.address, port: hop.address.port });

using _up = proxy.add(new Timeout({ stream: 'upstream', timeout: 0 }));
using _down = proxy.add(new Timeout({ stream: 'downstream', timeout: 0 }));
// The network is partitioned: no byte passes, and the proxy closes no socket.
```

Declare the proxy before the serving. `await using` then closes the serving first and disposes the proxy last ([ADR 0003](./docs/adr/0003-a-proxy-is-a-handler-that-a-server-serves-and-it-forwards-each-connection-to-its-upstream.md)).

## Forward to a real server

`new Proxy(upstream, { clock })` says where to forward. `proxy.forward` is the handler of a `Server`. For each accepted socket, the proxy connects to the upstream, and forwards each direction through a `pipeline` of `node:stream/promises`.

- When the connect to the upstream fails, the proxy destroys the accepted socket, as Toxiproxy closes the client.
- `allowHalfOpen: true` on the `Server` lets a client's end reach the upstream as an end.
- `clock` is required: the toxics wait on it (root ADR 0004). An app gives `globalThis`, and a test can give the clock of `@sinonjs/fake-timers`.
- The disposal of the proxy destroys each socket that it opened to the upstream and waits for its `close`.

## Add a fault and remove it

`proxy.add(toxic)` gives a `Disposable`. The toxic acts on its stream of each open connection and of each later one, until its disposal ([ADR 0004](./docs/adr/0004-a-toxic-is-a-strategy-for-one-stream-of-each-connection-and-add-gives-a-disposable.md)).

| Call                                               | What happens underneath                                                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `using fault = proxy.add(toxic)`                   | Each connection gets a stage for the toxic on its `stream`, after the stages of the earlier adds.                           |
| `fault[Symbol.dispose]()`, or the end of the scope | The stage stops. What it holds goes on with no more delay. What it dropped stays dropped. Later chunks pass with no change. |
| two toxics on one stream                           | They act in the order of their adds.                                                                                        |
| a toxic on both streams                            | Two adds, one for each stream, as in Toxiproxy.                                                                             |

`upstream` is the stream from the client to the server. `downstream` is the stream from the server to the client.

## Choose a fault

| Fault                                   | Toxic                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A slow link                             | `new Latency({ stream, latency })`: each chunk and the end arrive `latency` ms late.                          |
| A partition                             | `new Timeout({ stream, timeout: 0 })` on both streams: chunks drop, and the proxy closes no socket.           |
| No answer, then a close                 | `new Timeout({ stream, timeout })`: chunks drop, and the connection closes after `timeout` ms.                |
| A reset                                 | `new ResetPeer({ stream, timeout })`: at the first chunk, after `timeout` ms, a TCP reset.                    |
| Small reads                             | `new Slicer({ stream, averageSize, sizeVariation, delay })`                                                   |
| A stall in the middle of an answer      | `new StallAfter({ stream: 'downstream', bytes })`: after `bytes` bytes, it holds all; `reached` settles then. |
| A machine that is gone                  | `new Vanish({ stream })` on both streams: no byte, no end and no error reaches the other side.                |
| A server that accepts and never answers | Not a toxic: `new Server(() => {}).serve(new TcpEndpoint())` of `@zukhruf/net`.                               |

`Latency`, `Timeout`, `ResetPeer` and `Slicer` are Toxiproxy's toxics `latency`, `timeout`, `reset_peer` and `slicer`. `StallAfter` and `Vanish` are our own: Toxiproxy's `limit_data` closes the connection, and its README lists no toxic that holds the close of a side ([ADR 0005](./docs/adr/0005-the-toxics-are-latency-timeout-reset-peer-and-slicer-after-toxiproxy-and-stall-after-and-vanish-are-our-own.md)).

## Write a toxic

`Toxic` is an interface. A host writes its own toxic with `stream` and `pipe(chunks, link)`: `pipe` takes the chunks of one stream of one connection and gives the chunks that reach the other side.

```ts
import type { Link, Toxic } from '@zukhruf/chaos';

/** Drops every chunk after the first. */
class FirstChunkOnly implements Toxic {
  readonly stream = 'downstream';
  async *pipe(chunks: AsyncIterable<Buffer>, _link: Link) {
    for await (const chunk of chunks) {
      yield chunk;
      break;
    }
    await new Promise(() => {});
  }
}
```

- The end of `chunks` goes to the other side after the last chunk that `pipe` gave. A `pipe` that never returns holds the end.
- An error of the sending socket is a throw of `chunks`. A `pipe` that does not catch it ends the connection.
- `link.clock` is the clock of the proxy. `link.reset()` ends both sockets with a TCP reset. `link.close()` destroys both sockets.

## Errors

The package has no error class of its own.

| Error                         | When                                                                        |
| ----------------------------- | --------------------------------------------------------------------------- |
| none: the client sees a close | The connect to the upstream failed. The proxy destroys the accepted socket. |
| `ECONNRESET` at the client    | A `ResetPeer`, or a reset of the upstream that no toxic catches.            |

## What the package does not do

- **Listen.** A `Server` of `@zukhruf/net` listens and keeps the accepted sockets.
- **HTTP faults** (a status, a body, a header). The faults are in the bytes. An HTTP fault is a handler of `@zukhruf/net/http`.
- **Random faults.** No toxic has a toxicity or a jitter now: a fault happens each time, so a test is stable.
- **A proxy in another process, with an HTTP API.** That is Toxiproxy.
- **Later, on the map:** `limit_data`, `bandwidth`, `slow_close`, `jitter`, an upstream on a pipe (testing's `EngineProxy`).

## Who uses it

| Consumer                                                                                 | How                                                          | Record         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------- |
| mutex subjects mariadb, mysql, postgres, sqlserver (`partitionable`)                     | `Timeout` with `timeout: 0` on both streams, today `proxyTo` | backlog #6078  |
| testing database tests mariadb, mysql, postgres, sqlserver                               | `Latency` on `upstream`, today `slowProxy`                   | backlog #6078  |
| mutex `sqlserver-store.vanished-holder.test.ts`                                          | `Vanish` on both streams, today `vanishingHop`               | mutex ADR 0035 |
| elt `sql-server-request.test.ts`, `sql-server-source.test.ts` (later, after the release) | `StallAfter` on `downstream`, today `relay`                  | backlog #6078  |

## The same concepts in other systems

| Concept                  | Other systems                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| A proxy with toxics      | [Toxiproxy](https://github.com/Shopify/toxiproxy#toxics): proxies, toxics, `stream`                      |
| Faults in a program      | [Polly Simmy](https://www.pollydocs.org/chaos/) chaos strategies of .NET                                 |
| A network fault in Linux | `tc qdisc ... netem delay` and `loss`, [netem(8)](https://man7.org/linux/man-pages/man8/tc-netem.8.html) |

## Why not a package of npm

The npm candidates are not probed yet. By their npm metadata of 2026-11-28, `toxy` 0.3.16 (last change 2022) is "Hackable HTTP proxy to simulate server failure scenarios and network conditions" and `chaos-proxy` 1.0.0 is "Express-based proxy and CLI for injecting network chaos ... into API requests": both are HTTP proxies, and the copies fault raw TCP of database drivers. Their probe is item 10 of [Open for the review](#open-for-the-review).

## API

```ts
import type { Socket } from 'node:net';

import type { Clock } from '@zukhruf/async';
import type { Handler } from '@zukhruf/net';

export type Stream = 'upstream' | 'downstream';

/** What a toxic gets for one stream of one connection. */
export interface Link {
  readonly clock: Clock;
  /** Ends both sockets with a TCP reset. */
  reset(): void;
  /** Destroys both sockets. */
  close(): void;
}

/** A fault on one stream of each connection of a proxy. */
export interface Toxic {
  readonly stream: Stream;
  pipe(chunks: AsyncIterable<Buffer>, link: Link): AsyncIterable<Buffer>;
}

export interface Upstream {
  /** A host name or an IP address. */
  readonly host: string;
  readonly port: number;
}

export class Proxy implements AsyncDisposable {
  constructor(upstream: Upstream, options: { readonly clock: Clock });
  /** The handler that a Server of @zukhruf/net serves. */
  readonly forward: Handler;
  /** Puts the toxic on its stream of each open and each later connection. */
  add(toxic: Toxic): Disposable;
  /** Destroys each socket to the upstream, and waits for each close. */
  [Symbol.asyncDispose](): Promise<void>;
}

export class Latency implements Toxic {
  constructor(options: { readonly stream: Stream; readonly latency: number });
}

export class Timeout implements Toxic {
  /** timeout 0: drop until the removal, and never close. */
  constructor(options: { readonly stream: Stream; readonly timeout: number });
}

export class ResetPeer implements Toxic {
  constructor(options: { readonly stream: Stream; readonly timeout: number });
}

export class Slicer implements Toxic {
  constructor(options: {
    readonly stream: Stream;
    readonly averageSize: number;
    readonly sizeVariation: number;
    /** Milliseconds between two pieces. */
    readonly delay: number;
  });
}

export class StallAfter implements Toxic {
  constructor(options: { readonly stream: Stream; readonly bytes: number });
  /** Settles when a connection has passed `bytes` bytes on the stream. */
  readonly reached: Promise<void>;
}

export class Vanish implements Toxic {
  constructor(options: { readonly stream: Stream });
}
```

## Open for the review

Each item is a detail that a caller sees and that no record decides. Each has a proposal and the leader that it follows.

1. **The type of the upstream.** Proposal: `{ host, port }`, where `host` can be a host name, as Toxiproxy's `upstream` is `host:port`. A `net.SocketAddress` refuses a host name (`ERR_INVALID_ADDRESS` for `localhost`, Node 26.13.1), and a Docker host can be a name. An upstream on a pipe (a `PipeAddress`) is later, for `EngineProxy`.
2. **The clock is an option of `Proxy`, not of each toxic.** Proposal: one required `clock` for the proxy, given to each toxic through `link.clock`, so a test gives it once (root ADR 0004). Toxiproxy's toxics read the time of Go.
3. **The name of the handler.** Proposal: `proxy.forward`, a field that holds a function, so `new Server(proxy.forward)` needs no `bind`. Toxiproxy has no such object: its proxy listens itself.
4. **`stream` is required, with no default.** Toxiproxy's default is `downstream`. Proposal: required, because the copies fault `upstream` (`slowProxy`), `downstream` (elt) and both (`proxyTo`, `vanishingHop`), and a silent default faults one half of a partition.
5. **The options of each toxic are one object, with Toxiproxy's attribute names in camel case.** Proposal: `{ stream, latency }`, `{ stream, timeout }`, `{ stream, averageSize, sizeVariation, delay }`, `{ stream, bytes }`. The record writes `Timeout (0 = partition)`, which could also read as `new Timeout(0)`.
6. **Milliseconds for each time.** Toxiproxy's `slicer` takes `delay` in microseconds, and its other toxics take milliseconds. Proposal: milliseconds for each, as `setTimeout` and the `Clock` of `@zukhruf/async`.
7. **No `jitter` and no `toxicity` now.** Toxiproxy has both. Proposal: later, when a consumer needs one; each takes a source of random numbers as an input then.
8. **What `StallAfter.reached` gives.** elt's `stallAfter` resolves with the bytes that the client had sent. Proposal: `Promise<void>`; a count of bytes is a fact of the connection, not of the toxic. elt's move decides it.
9. **The count of `StallAfter` is for each connection, and it acts on later connections too.** elt counts over all connections and lets a later connection pass. Proposal: Toxiproxy's model, one state for each link; the move of elt's two tests proves it is enough, or names the gap.
10. **npm candidates.** `toxy` and `chaos-proxy` are not probed. Proposal: probe both before the build, and record why each fails or is used.
11. **The `link.reset()` side.** Toxiproxy's `reset_peer` closes its stub ([reset_peer.go](https://github.com/Shopify/toxiproxy/blob/main/toxics/reset_peer.go)). Proposal: `resetAndDestroy()` on both sockets, so the client and the server each see `ECONNRESET`.
12. **The class name `Proxy` hides the global `Proxy` of JavaScript** in each module that imports it. The record names it `class Proxy(upstream)`, after Toxiproxy's proxy. Proposal: keep the name, because a test file seldom uses the global `Proxy`; the other choice is `TcpProxy`, which names the transport as Go names `TCPConn`.

## Documentation

**Decisions**

- [ADR 0001](./docs/adr/0001-a-tool-package-on-net-holds-the-faults-that-a-proxy-injects-between-a-client-and-a-real-server.md): a tool package on net holds the faults that a proxy injects between a client and a real server.
- [ADR 0002](./docs/adr/0002-the-name-is-chaos.md): the name is chaos.
- [ADR 0003](./docs/adr/0003-a-proxy-is-a-handler-that-a-server-serves-and-it-forwards-each-connection-to-its-upstream.md): a proxy is a handler that a server serves, and it forwards each connection to its upstream.
- [ADR 0004](./docs/adr/0004-a-toxic-is-a-strategy-for-one-stream-of-each-connection-and-add-gives-a-disposable.md): a toxic is a strategy for one stream of each connection, and add gives a disposable.
- [ADR 0005](./docs/adr/0005-the-toxics-are-latency-timeout-reset-peer-and-slicer-after-toxiproxy-and-stall-after-and-vanish-are-our-own.md): the toxics are Latency, Timeout, ResetPeer and Slicer after Toxiproxy, and StallAfter and Vanish are our own.
