# The connection to a coordinator is separate from the lock requests

`ThreadStore`, `IpcStore`, and `SocketStore` ask a coordinator for keys through `RemoteLockClient`. This class did two jobs. It kept the connection to the coordinator, and it kept the requests, the held keys, and the lost leases. Three fields recorded the state of the connection, and some of their combinations had no meaning. Defects came from these combinations. For example, a waiter got a grant after its lock store closed, and an acquire went to a new leader two times after a failover. Thus `ConnectionSupervisor` keeps the connection, and `RemoteLockClient` keeps the requests. The supervisor connects at the first request, connects again when a connection closes, and stops when no coordinator is left. It does not read the messages. After a failover, `RemoteLockClient` decides what the new leader must get: a reassert for each held key, and each acquire that has no answer.

## Considered Options

- **One state field in `RemoteLockClient`.** One field with five values removes the combinations that have no meaning. But one class still does two jobs.
- **A new `RemoteLockClient` for each connection.** The coordinator uses one session for each connection, because a process that disconnects releases all its keys. A holder must keep its keys after a failover. Thus its requests and leases must stay when the connection changes.
- **A supervisor that sends the requests again itself.** Then the supervisor must know that a `try` is not sent again, and that a release to a stopped coordinator has no effect. These are rules of the lock requests, not of a connection.

## Consequences

- Each state of the connection is an object. An event from a connection that the supervisor replaced has no effect, because its state is not the current state.
- `Connector.connect` gets an `AbortSignal`. When a lock store closes, the supervisor stops the connect that is in progress. A `SocketStore` that you dispose during a campaign does not start to serve, and it ends a term that it wins after that.
- When a lock store closes, each waiter gets an error. Before, a waiter waited forever.
- When a connect fails, for example when a campaign gets a disk error, each waiter gets that error. Each holder gets `LockLostError` when it releases, because no leader got its reassert. The next request connects again.
