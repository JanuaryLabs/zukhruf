# Chaos

Faults in the bytes of a real TCP connection, between a client of a test and a real server. A proxy forwards each connection to the real server, and toxics on it change what passes. The package owns the forward and the faults. The server that listens comes from `@zukhruf/net`.

## Language

**Proxy**:
The handler of a `Server` of `@zukhruf/net` that connects each accepted socket to its upstream and forwards the bytes in both directions, through its toxics. Toxiproxy's proxy, without the listen.
_Avoid_: Hop, relay, tcp proxy (the names of the copies)

**Upstream**:
The real server that a proxy forwards to: a host and a port. Toxiproxy's `upstream`.
_Avoid_: Target, backend

**Stream**:
One direction of a connection through a proxy. `upstream` is from the client to the server, `downstream` is from the server to the client. Toxiproxy's `stream`.
_Avoid_: Direction (in the API), side

**Toxic**:
A fault that acts on one stream of each connection of a proxy: it takes the chunks of the stream and gives the chunks that reach the other side. Toxiproxy's toxic.
_Avoid_: Fault (for the object), filter, middleware

**Link**:
What a toxic gets for one stream of one connection: the clock of the proxy, and the reset and the close of the connection. Toxiproxy's link and its stub.
_Avoid_: Context, connection (for the object that a toxic gets)

**Partition**:
A network that stops with no reset and no close: no byte passes in either direction, and the proxy closes no socket. `Timeout` with `timeout: 0` on both streams. A close of a peer still goes through.
_Avoid_: Disconnect, drop (for the whole state)

**Stall**:
A stream that stops after a count of bytes and keeps its connection open. `StallAfter`; our own term, since Toxiproxy's `limit_data` closes the connection.
_Avoid_: Limit, freeze

**Vanish**:
A side of a connection that is gone with no word: no byte, no end and no error of it reaches the other side, as a gateway for a machine that stopped. `Vanish`; our own term (mutex ADR 0035).
_Avoid_: Partition (it forwards the close), disappear
