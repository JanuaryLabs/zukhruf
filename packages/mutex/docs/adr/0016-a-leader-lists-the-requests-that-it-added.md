# A leader lists the requests that it added

`isHeld` is the first request after protocol version 1 ([ADR 0014](./0014-a-process-says-its-protocol-version-before-its-first-request.md), [ADR 0015](./0015-a-holder-check-never-acquires-the-key.md)). A leader of version 0.3.9 or earlier does not know it, and it closes the connection of a process that sends a request that it does not know. The process then connects again and reasserts its keys. But that leader is past its grace window, so it refuses the keys, and the process loses them. Other protocols have the same problem when two versions talk. [Kafka](https://cwiki.apache.org/confluence/display/KAFKA/KIP-35+-+Retrieving+protocol+version) and the [Language Server Protocol](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) let each side say which requests it answers, and a peer sends only those. [PostgreSQL](https://www.postgresql.org/docs/current/protocol-message-formats.html) answers an unknown option of a client with `NegotiateProtocolVersion` and keeps the connection. [JSON-RPC](https://www.jsonrpc.org/specification) answers an unknown method with the error `-32601`. Thus this project does two things. First, a leader lists in its `welcome` the requests that it added after protocol version 1: `{"op":"welcome","ops":["isHeld"]}`. A `welcome` without `ops` comes from a leader of 0.3.9 or earlier. A process sends an added request only to a leader that lists it. Otherwise the request fails at once with `UnsupportedRequestError`, and nothing goes to the leader. Second, a coordinator answers a request that it does not know with `{"op":"unsupported","id":…}`, and it keeps the connection. This applies to sockets, IPC channels and worker ports. `PROTOCOL_VERSION` stays 1. A process of 0.3.9 or earlier reads only the `op` of a `welcome`, so it still works with a new leader.

## Considered Options

- **`PROTOCOL_VERSION` 2.** This is the rule of ADR 0014 for a changed message. But no message changed: `isHeld` is a new one. Processes of 0.3.x and of a later version would refuse each other for each request, also for an acquire, until all of them are upgraded.
- **Only the answer `unsupported`.** Leaders of 0.3.9 or earlier are already released, and they close the connection. Thus a process must know what the leader answers before it sends a request.
- **A change in two steps.** In Kafka, an operator sets `inter.broker.protocol.version` to the new version after all brokers run it. A library has no operator to do that step.
- **The package version in the `welcome`.** ADR 0014 rejected the package version in the `hello` for the same reason: each new package version would refuse all earlier ones, also when their messages are the same.

## Consequences

- Processes of 0.3.x and of later versions share a directory. Against a leader of 0.3.9 or earlier, only a holder check fails.
- After a failover to a leader of an earlier version, a holder check that waits for its answer fails with `UnsupportedRequestError`.
- IPC channels and worker ports have no `welcome`, so a process expects that its coordinator knows each request. A coordinator of 0.3.9 or earlier ignores a request that it does not know, and a holder check of its child or worker waits. Use one package version in a process tree.
- When you add a request, add it to `ADDED_OPS`. When you change a message, change `PROTOCOL_VERSION`, as ADR 0014 says.
- A line that is not a request, with no `op` or no `id`, still closes the socket connection.
