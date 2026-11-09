# A connection closes only when its framing breaks

The processes of a directory talk to their coordinator on a socket. Each message is one JSON line. A connection carries the messages, and it does not read them. Two classes read them. The session of the coordinator reads the requests, and `FlightClient` reads the answers. Before, the socket connection also checked each message. It closed for a line that is not JSON, and it also closed for a JSON line that failed the check.

A closed connection has a cost. The session of that connection ends, and the coordinator interrupts each flight that the process leads. Each joiner of those flights gets `FlightInterruptedError`, and no joiner runs the work again. Thus one JSON line that the coordinator cannot read stopped flights that ran correctly. The mutex had the same problem, and its [ADR 0017](../../../mutex/docs/adr/0017-a-connection-closes-only-when-its-framing-breaks.md) gives the rule. This package now uses that rule.

Thus a connection closes only when its framing breaks. The framing is one JSON line for each message. A line that is not JSON shows that the stream is broken, so no later line is safe to read, and the connection closes. The connection gives each JSON value to its listener without a check. The session ignores a message that is not a flight request that it knows. Until 2026-11-09, it answered a request with an `op` that it did not know with `unsupported`. `FlightClient` ignores a message that is not an answer that it knows.

The first line is a different case. Before the welcome, the coordinator reads only a hello. It refuses each other first line with `refused` and its protocol version, and then it closes the connection ([copied-from-mutex.md](../copied-from-mutex.md), the handshake). That process leads no flight yet, so the close stops nothing.

## Considered Options

- **Close the connection for each message that cannot be read.** This was the behavior before. One incorrect line interrupts each flight that the process leads.
- **Answer an error for a message without an `id`.** The other side cannot match that error to a request. JSON-RPC answers with `"id": null` for this case, and its client can only log the error.
- **Each connection checks the messages with its own check.** This was the behavior before. The connection then must know the flight protocol. The connection code is a copy of the mutex code ([ADR 0006](./0006-the-election-and-the-connection-are-a-copy-of-the-mutex-code.md)), and the mutex removed that check in its ADR 0017. With the same rule, the two copies stay the same until a third package needs them.

## Consequences

- After the welcome, a JSON line that is not a flight request is ignored. The connection stays open, and the flights that the process leads continue. The test "a peer that sends a JSON line that is not a request keeps its flight" shows this.
- A line that is not JSON still closes the connection.
- A first line that is not a hello of this protocol and version gets `refused`, and the connection closes.
- `Connection<Outgoing>` gives each message as `unknown`. A new reader of flight messages must check each message before it reads it.
- Since [ADR 0010](./0010-a-leader-holds-a-kernel-lock-on-its-key-until-its-outcome-is-handed-over.md), the coordinator checks the kernel lock on a key before a run of the key leads. That check is advice only. When it fails, the key counts as not held, and the leader's own lock decides. Thus a fault of the check never refuses a run or a rejoin, and it never closes a connection.
