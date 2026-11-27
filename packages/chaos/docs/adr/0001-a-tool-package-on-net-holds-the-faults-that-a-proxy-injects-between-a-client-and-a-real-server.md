# A tool package on net holds the faults that a proxy injects between a client and a real server

Status: Proposed 2026-11-28 (backlog #6078).

Decision-makers: Ezz, on 2026-11-27. The record says: "HOME: a BASE package owns the connections ... The faults (delay, partition, silence, stall after N bytes, reset) go in a separate TOOL package on top of it." The zukhruf session of backlog #6078 decided the shape from the leaders (step 1 verdict, 2026-11-27): "The fault hop is the TOOL package, Toxiproxy-shaped".

A test of a client of a database or of an SSH server must see the network fail: a slow link, a partition, a reset, a peer that stops in the middle of an answer. The tests of four repositories do it with a proxy of their own between the client and a real server. Each copy has the skeleton of `@zukhruf/net` (a server on a free port that keeps its sockets) and one fault on top:

| Copy                                                                         | Its fault                                                                                                                                                                                                                           | Its users                                                                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| mutex `src/testing/tcp-proxy.ts:15` `proxyTo`                                | `partition()`: no more bytes in either direction, no socket closes                                                                                                                                                                  | the subjects mariadb, mysql, postgres, sqlserver; a type import of `sqlserver-store.vanished-holder.test.ts` |
| testing `src/testing/slow-proxy.ts:11` `slowProxy`                           | `slowDown(ms)`: the client's bytes and its end reach the server `ms` later; a count of connections                                                                                                                                  | the database tests mariadb, mysql, postgres, sqlserver                                                       |
| mutex `sqlserver-store.vanished-holder.test.ts:47` `vanishingHop`            | `vanish()`: no more bytes, no close and no reset in either direction, as a gateway for a machine that is gone ([mutex ADR 0035](../../../mutex/docs/adr/0035-a-sql-server-key-is-a-lease-that-ends-unless-its-holder-renews-it.md)) | its own file                                                                                                 |
| elt `sql-server-request.test.ts:34`, `sql-server-source.test.ts:241` `relay` | `stallAfter(bytes)`: after `bytes` more bytes from the server, hold all that the server sends                                                                                                                                       | their own files                                                                                              |

Backlog #5655 counted the hop at four places on 2026-11-25 and proposed `TcpHop.to({ host, port })` in `@zukhruf/testing`. This decision takes that need and moves its home below `@zukhruf/testing`.

## The leaders

| Leader                                                   | Model                                                                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Toxiproxy](https://github.com/Shopify/toxiproxy#toxics) | A proxy listens and forwards to an upstream. Toxics are added to a proxy and removed from it; each toxic acts on one stream, `upstream` or `downstream`. |
| [Polly Simmy](https://www.pollydocs.org/chaos/)          | Chaos strategies in a resilience pipeline of .NET: fault, latency, outcome, behavior. It acts on calls of the program, not on bytes.                     |
| Go x/net nettest                                         | A conformance test of a `net.Conn`; no faults ([docs](https://pkg.go.dev/golang.org/x/net/nettest)).                                                     |

Only Toxiproxy injects faults into the bytes of a real TCP connection. It is a server of its own, with an HTTP API; this package does the same in the process of the test.

## Decision

1. A new package of the tool layer (`std:tool`, `layer:island`) holds the proxy and its faults. Its name is `@zukhruf/chaos` ([ADR 0002](./0002-the-name-is-chaos.md)).
2. It imports `@zukhruf/net` (the server and the endpoints) and `@zukhruf/async` (the `Clock` type of root ADR 0004), and no other zukhruf package. Thus the tests of `docker`, `ssh`, `mutex`, `single-flight`, `election` and `testing` can use it. The tests of `async` cannot.
3. Its model is Toxiproxy's: a proxy, toxics, and a stream for each toxic ([ADR 0003](./0003-a-proxy-is-a-handler-that-a-server-serves-and-it-forwards-each-connection-to-its-upstream.md), [ADR 0004](./0004-a-toxic-is-a-strategy-for-one-stream-of-each-connection-and-add-gives-a-disposable.md)).
4. Silence (a server that accepts and never answers) is not a fault of this package: it is a `Server` of `@zukhruf/net` with a handler that does nothing.

## Considered Options

- **The faults in `@zukhruf/net`.** Shipped code does not inject faults, and a base package does not carry tool code. Ezz chose two packages.
- **An area of `@zukhruf/testing`**, as #5655 proposed. The tests of `docker` and `ssh` cannot import `@zukhruf/testing`, which depends on them (root ADR 0001).
- **Toxiproxy itself, in a container.** Each test then needs a Docker engine and an HTTP call for each toxic, and the faults of zukhruf's own (`StallAfter`, `Vanish`) have no toxic there.
- **A tool package on net.** This option was selected.

## Consequences

- The tool row of root ADR 0001 gets `chaos`.
- Backlog #5655 closes with #6078.
- The copies move: `proxyTo`, `slowProxy` and `vanishingHop` now; elt's relays after the release and the install of the package in elt ([ADR 0005](./0005-the-toxics-are-latency-timeout-reset-peer-and-slicer-after-toxiproxy-and-stall-after-and-vanish-are-our-own.md)).

## Confirmation

- The copies and their users: `~/.claude/plans/test-primitives-6078/map.txt` (2026-11-28, session f0478ea1).
- The Toxiproxy README, read on 2026-11-28.
