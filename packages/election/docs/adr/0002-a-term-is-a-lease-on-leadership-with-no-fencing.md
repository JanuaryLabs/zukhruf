# A term is a lease on leadership, with no fencing

`@zukhruf/lease` gives a holder a signal that aborts when another holder may have the right. A term of this package had a copy of that code, with its own names: a `#lost` controller, an `#ending` controller, and an error class of its own for a lost term. A term gives its leader the right to act for the group, and a backend can take that right away. That is a lease, and its subject is the leadership. Thus `Term` implements the `Lease` interface, and a `LeaseController` with the subject `'leadership'` aborts its signal. The error class of the term is gone. The signal aborts with `LeaseLostError`, and the `cause` of the error is the reason of the backend.

A term has no fencing token. Its epoch stays a `bigint`, and this package does not import `@zukhruf/fencing`. Other systems also keep the election apart from fencing:

- The leader election of Kubernetes client-go keeps the leader in a `coordination.k8s.io/v1` `Lease`. Its documentation says that it "does not guarantee that only one client is acting as a leader (a.k.a. fencing)".
- The `Election` of etcd, in its `concurrency` package, is built on a `Session`, and a session is a lease.
- The epoch is the term number of Raft: each new leader has a higher number than each leader before it.

Fencing belongs to the code that issues grants and to the resource that it protects. The resource keeps the highest token that it accepted, and it refuses a lower token. A leader that issues grants makes its tokens from the epoch: `new EpochTokenSource(term.epoch)` of `@zukhruf/fencing`. That source puts the epoch in the high bits of each token, so each token of a newer leader is higher than each token of an older leader.

## Considered Options

- **Keep the error class of the term.** A catch must then know each issuer: `LeaseLostError` for the mutex and the single flight, and a different class for the election. The term also keeps its copy of the code of `LeaseController`, and a fix in one place does not get to the other.
- **A term is a fenced lease, with a token made from its epoch.** One token for each term cannot put the grants of one leader in order: a leader issues many grants, and each grant needs a higher token. A resource also compares the tokens of one key from one source, and the election does not know the keys. A leader that protects no resource needs no token, but it would depend on `@zukhruf/fencing`.
- **A term is a lease with no fencing, and its epoch stays a number.** This option was selected.

## Consequences

- `instanceof LeaseLostError` catches a lost term, a lost key of the mutex, and a lost flight. The `subject` of the error tells them apart: the subject of a term is `'leadership'`.
- This package depends on `@zukhruf/lease`. It exports `LeaseLostError` too, because the signal of a term aborts with it. It does not export `Lease`: import that type from `@zukhruf/lease`.
- The rules of a term do not change. A resign never aborts the signal. A loss after a resign began does nothing. The campaign never calls `release` after a loss.
- To protect a resource, a leader makes tokens with `EpochTokenSource`. This package does not make them for the leader.
