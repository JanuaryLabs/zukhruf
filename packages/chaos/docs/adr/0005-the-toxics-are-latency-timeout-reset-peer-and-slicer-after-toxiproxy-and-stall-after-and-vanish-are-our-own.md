# The toxics are Latency, Timeout, ResetPeer and Slicer after Toxiproxy, and StallAfter and Vanish are our own

Status: Accepted 2026-11-28 (backlog #6078). Ezz approved the paper of 028f631b as written.

Decision-makers: Ezz, on 2026-11-28, for the six classes: "Latency, Timeout (0 = partition), ResetPeer, Slicer (Toxiproxy names), StallAfter, Vanish". The record also says: "Decided by the session from the leaders (not questions): ... both own faults ship (stallAfter for elt, vanish for mutex ADR 0035)". The zukhruf session of backlog #6078 proposes the options of each class; their names and units are in the "Open for the review" list of the README.

## The leaders

The toxics of [Toxiproxy](https://github.com/Shopify/toxiproxy#toxics), quoted from its README of 2026-11-28:

| Toxic        | Attributes                                             | What it does                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `latency`    | `latency`, `jitter` (ms)                               | "Add a delay to data on a single proxy stream. The delay is equal to `latency` +/- `jitter`."                                                                                                                                |
| `timeout`    | `timeout` (ms)                                         | "Stops all data from getting through, and closes the connection after `timeout`. If `timeout` is 0, the connection won't close, and data will be dropped until the toxic is removed."                                        |
| `reset_peer` | `timeout` (ms)                                         | "Simulate TCP RESET (Connection reset by peer) on the connections"; its `Pipe` waits for the first chunk, then `timeout`, then closes ([reset_peer.go](https://github.com/Shopify/toxiproxy/blob/main/toxics/reset_peer.go)) |
| `slicer`     | `average_size`, `size_variation` (bytes), `delay` (µs) | splits the data into small pieces, with a delay between them                                                                                                                                                                 |
| `limit_data` | `bytes`                                                | "Closes connection when transmitted data exceeded limit."                                                                                                                                                                    |
| `bandwidth`  | `rate` (KB/s)                                          | "Limit a connection to a maximum number of kilobytes per second."                                                                                                                                                            |
| `slow_close` | `delay` (ms)                                           | "Delay the TCP socket from closing until `delay` has elapsed."                                                                                                                                                               |

No toxic of Toxiproxy holds the data after a count of bytes and keeps the connection open: `limit_data` closes it. The README lists no toxic that keeps the other side open when one side closes.

## Decision

| Class        | What it does on its stream                                                                                                                                                                                     | The copy that it replaces                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `Latency`    | Each chunk and the end reach the other side `latency` ms after they arrived, in their order. Toxiproxy's `latency`.                                                                                            | testing `slowProxy`'s `slowDown(ms)`, on `upstream`                |
| `Timeout`    | Drops each chunk. After `timeout` ms it closes the connection. With `timeout: 0` it never closes, and an end or a close of a peer still goes through. Toxiproxy's `timeout`.                                   | mutex `proxyTo`'s `partition()`, on both streams with `timeout: 0` |
| `ResetPeer`  | At the first chunk, it waits `timeout` ms, then ends the connection with a TCP reset (`link.reset()`). Toxiproxy's `reset_peer`.                                                                               | none now; the reset of #5655                                       |
| `Slicer`     | Splits each chunk into pieces of `averageSize` ± `sizeVariation` bytes, with `delay` between two pieces. Toxiproxy's `slicer`.                                                                                 | none now                                                           |
| `StallAfter` | Passes `bytes` bytes, then holds each later chunk and the end, and keeps the connection open. `reached` settles when the count is reached. Our own fault.                                                      | elt's `relay` `stallAfter(bytes)`, on `downstream`                 |
| `Vanish`     | Drops each chunk, and drops the end and the error of its input: the other side never learns that this side ended. Our own fault, for "a gateway ... for a client machine that is gone" (mutex `vanishingHop`). | mutex `vanishingHop`'s `vanish()`, on both streams                 |

- `StallAfter` and `Vanish` are our own terms; the README and [CONTEXT.md](../../CONTEXT.md) say so.
- `Timeout` with `timeout: 0` and `Vanish` differ only at the end of a side. `proxyTo` "stops the bytes but still forwards a close, so the end of the holder's session would reach the server" (the comment of `vanishingHop`). That close is the fact that mutex ADR 0035 tests, so both classes ship.
- `limit_data`, `bandwidth` and `slow_close` are not in the package: no consumer needs them. They are on the map as later.
- The `jitter` of `latency` is not in the package now: no consumer needs it, and a random jitter makes a test that reads the time unstable.

## Considered Options

- **`StallAfter` as `limit_data` with no close.** A name of Toxiproxy with another behavior would mislead a reader who knows Toxiproxy.
- **`Vanish` as `Timeout` with `timeout: 0`.** It forwards the close, and mutex ADR 0035 needs a close that never comes.
- **Only Toxiproxy's toxics.** elt and mutex then keep their copies.
- **The four toxics of Toxiproxy that the copies need, and the two faults of our own.** This option was selected.

## Consequences

| Copy today                | With the package                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `proxy.partition()`       | `proxy.add(new Timeout({ stream: 'upstream', timeout: 0 }))` and `proxy.add(new Timeout({ stream: 'downstream', timeout: 0 }))` |
| `proxy.slowDown(1_000)`   | `proxy.add(new Latency({ stream: 'upstream', latency: 1_000 }))`                                                                |
| `proxy.connections()`     | `serving.connections` of `@zukhruf/net`                                                                                         |
| `hop.vanish()`            | `Vanish` on `upstream` and on `downstream`                                                                                      |
| `await hop.stallAfter(1)` | `const stall = new StallAfter({ stream: 'downstream', bytes: 1 }); proxy.add(stall); await stall.reached`                       |

- elt's relays move later, after the release and the install of the package in elt. elt's `stallAfter` counts the bytes of all connections, holds only the connections that are open when it is reached, and resolves with the bytes that the client had sent. A toxic counts each connection alone and acts on later connections too ([ADR 0004](./0004-a-toxic-is-a-strategy-for-one-stream-of-each-connection-and-add-gives-a-disposable.md)). The move of elt's two tests proves that the per-connection count is enough, or it names the gap ("Open for the review").
- `Latency` delays the end too, so a client's end reaches the server late, as `slowProxy` does with `allowHalfOpen`.
