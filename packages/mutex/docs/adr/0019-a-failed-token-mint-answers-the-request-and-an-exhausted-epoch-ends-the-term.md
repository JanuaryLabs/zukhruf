# A failed token mint answers the request

A coordinator gives a fencing token with each grant ([ADR 0003](./0003-a-fencing-token-on-every-lease.md)). It gets the token from its token source. The token source can fail. For example, a `FileTokenSource` cannot write its file when the disk is full. Then the acquire, the try or the reassert of that key fails. The key is free again, because `leaseFor` gives it back.

Before this decision, `LockCoordinator` closed the connection of the process that sent the request. On a worker port or an IPC channel, `close()` removes the listeners of this side, but it does not emit `close` ([ADR 0017](./0017-a-connection-closes-only-when-its-framing-breaks.md)). Thus the session did not end. The worker or the child waited for its answer forever. The coordinator did not hear its later requests. It also kept the keys of that worker or child, also after it stopped. No other holder could get those keys again.

Now a failed mint never closes the connection. The coordinator answers the request:

- An acquire or a try gets the new answer `{"op":"failed","id":…,"message":…}`. The `message` is the message of the error of the token source. The client rejects the request with `GrantFailedError`. The request is no longer registered, so the same `id` can come again.
- A reassert gets `rejected`. Each version of the client reads `rejected` as a lost lease. The coordinator also forgets the token of the failed claim, so a later claim of the key is not refused because of it.

The connection, the session and all other keys of the process stay.

`failed` is a new answer, and ADR 0016 covers only new requests. A client of 0.3.17 or later ignores an answer that it does not know. A client of an earlier version can read it incorrectly. `PROTOCOL_VERSION` stays 1 all the same, because a coordinator sends `failed` only on a worker port or an IPC channel. There, the coordinator and its workers or children run one package version (ADR 0016). On a socket, a token source can fail only when its epoch has no tokens left.

## Considered Options

- **Close the connection, as before.** On a worker port or an IPC channel, the session never ends, and the keys of the worker or the child stay held forever. On a socket, a close loses all keys of the process for one failed request.
- **Answer `rejected` to an acquire or a try.** A client reads `rejected` only for a key that it holds. An acquire or a try that gets it waits forever.
- **Answer `busy` to a try.** The caller then thinks that another holder has the key. The error of the token source is lost.
- **`PROTOCOL_VERSION` 2.** Processes of two versions would refuse each other for each request until all of them are upgraded (ADR 0016). No process of another version ever gets `failed`.

## Consequences

- A worker or a child gets `GrantFailedError` for a failed mint. Its later requests are answered, and its keys are released when it stops. The tests in `A worker or child whose token cannot be minted` (`src/mutex/mutex.test.ts`) and `A request whose token cannot be minted` (`src/lock-stores/remote/remote-locking.test.ts`) show this.
- `GrantFailedError` has the `key`. The request did not run, and the key is not held.
- The single flight has a copy of the coordinator session (`coordinator/session.ts`). That copy still closes the connection.
