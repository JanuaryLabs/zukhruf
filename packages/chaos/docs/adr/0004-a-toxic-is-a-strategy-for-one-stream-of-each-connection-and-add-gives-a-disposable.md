# A toxic is a strategy for one stream of each connection, and add gives a disposable

Status: Accepted 2026-11-28 (backlog #6078). Ezz approved the paper of 028f631b as written.

Decision-makers: Ezz, on 2026-11-28, for the shape. The record says: "interface Toxic (a Transform per direction, Strategy) with classes Latency, Timeout (0 = partition), ResetPeer, Slicer (Toxiproxy names), StallAfter, Vanish; proxy.add(toxic) returns a Disposable". The zukhruf session of backlog #6078 proposes the method of the interface and what a removal does, from Toxiproxy's source. The default of the stream is in the "Open for the review" list of the README.

A test adds a fault in the middle of its run: mutex's subjects partition a connection that is already open, and elt stalls a batch after its first byte. Thus a fault acts on the connections that are open, and the test removes it when it is done.

## The leaders

| Toxiproxy                                                                                                                                                                                                                             | What it does                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A toxic has `Pipe(stub *ToxicStub)`: it reads the chunks of the stub's input and writes chunks to its output ([toxics/latency.go](https://github.com/Shopify/toxiproxy/blob/main/toxics/latency.go))                                  | one toxic is one stage of one direction of one link                                     |
| `stream`: "link direction to affect (defaults to `downstream`)" ([README](https://github.com/Shopify/toxiproxy#toxics))                                                                                                               | `upstream` is from the client to the server, `downstream` from the server to the client |
| `chainAddToxic` and `chainRemoveToxic` loop over `c.links` and add or remove the toxic on each link of its direction ([toxic_collection.go, about lines 273-333](https://github.com/Shopify/toxiproxy/blob/main/toxic_collection.go)) | an add and a removal act on the connections that are open, and on each later one        |
| On `stub.Interrupt`, the latency toxic writes the chunk that it holds with no delay, "Don't drop any data on the floor" ([toxics/latency.go, about lines 45-48](https://github.com/Shopify/toxiproxy/blob/main/toxics/latency.go))    | a removal does not lose the chunks that a toxic holds                                   |
| `POST /proxies/{proxy}/toxics` and `DELETE /proxies/{proxy}/toxics/{toxic}`                                                                                                                                                           | the add gives a name, and the removal takes it                                          |

## Decision

1. `Toxic` is an interface: the Strategy (GoF) of one stream. It has `stream`, `'upstream'` or `'downstream'`, and `pipe(chunks, link)`. `pipe` gets the chunks of one direction of one connection as an `AsyncIterable<Buffer>`, and gives the chunks that reach the other side, as an `AsyncIterable<Buffer>`. This is the form that `pipeline` takes as a transform, and Node.js makes a `Transform` of it with `Duplex.from`. It is Toxiproxy's `Pipe(stub)` in the iterators of JavaScript.
2. `link` gives a toxic what it cannot do with the chunks alone: `clock`, the clock of the proxy; `reset()`, which ends both sockets of the connection with a TCP reset (`socket.resetAndDestroy()`, [docs](https://nodejs.org/api/net.html#socketresetanddestroy)); and `close()`, which destroys both sockets. Toxiproxy's stub has `Close()`.
3. When the input of `pipe` ends, its end goes to the other side after the chunks that the toxic gave, so a toxic that holds a chunk also holds the end. When the input throws, a toxic that does not catch the error ends the connection.
4. `proxy.add(toxic)` puts the toxic on its stream of each open connection and of each later one, and gives a `Disposable`. Its `[Symbol.dispose]()` takes the toxic off each connection. Toxics of one stream act in the order of their adds, as Toxiproxy's chain.
5. A removal stops the toxic at once: what it holds goes on, with no more delay, as Toxiproxy's latency writes its held chunk at `Interrupt`; what it dropped stays dropped. Each later chunk passes the place of the toxic with no change.
6. The package exports its six toxics ([ADR 0005](./0005-the-toxics-are-latency-timeout-reset-peer-and-slicer-after-toxiproxy-and-stall-after-and-vanish-are-our-own.md)), and a host can write its own `Toxic`.

## Considered Options

- **A `Transform` object for each toxic.** One `Transform` is one stream of one connection, so a toxic that acts on ten connections would be ten objects that the caller cannot see. The toxic is a strategy, and the proxy makes the stage of each connection from it.
- **A name for each toxic, as Toxiproxy's HTTP API.** The API is HTTP, so it needs a key. In the process a `Disposable` is the key, and `using` removes the toxic at the end of the scope.
- **Toxics for new connections only.** mutex partitions a connection that is open, and elt stalls one.
- **A toxic that is a strategy over the chunks of one stream, added and removed on each connection.** This option was selected.

## Consequences

- A partition of both directions is two toxics, as in Toxiproxy: `proxy.add(new Timeout({ stream: 'upstream', timeout: 0 }))` and the same for `downstream`.
- The proxy changes the stages of a connection that is open. The build proves it with a test that adds and removes a toxic while bytes flow.
- `Disposable`, not `AsyncDisposable`: a removal does not wait for each connection, as Toxiproxy's `chainRemoveToxic` does (`wg.Wait()`). A chunk that is in a stage at the removal can still reach the other side after `[Symbol.dispose]()` returns.
