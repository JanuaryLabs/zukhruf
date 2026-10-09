# A lease is its own package, apart from fencing

Three issuers give a holder a right and tell the holder when it lost that right. Each one has its own copy of the same code, with its own names:

- `RemoteLockClient` of `@zukhruf/mutex` keeps `{ key, token, lost: AbortController }` for each held key. Its `#lose` aborts the signal with `LockLostError`. A loss after the release does nothing, because the release removed the held key. `leaseFor` of the mutex gives a signal that never aborts.
- `FlightClient` of `@zukhruf/single-flight` keeps the same record for each flight that it leads, and aborts with `LockLostError` too.
- `Term` of `@zukhruf/election` keeps a `#lost` controller and an `#ending` controller. It aborts with `TermLostError`. A loss after the leader starts to resign does nothing.

This project follows the Rule of Three: the third time you do something similar, you refactor. The count is the number of places, not the number of packages. Three places have this code, so it is in this package now. The three copies agree on three rules, and this package keeps them:

1. The signal aborts one time, and the reason names what the holder lost.
2. A release never aborts the signal.
3. A loss after the release does nothing.

The names come from other systems. A **lease** is the term of Gray and Cheriton ("Leases: An Efficient Fault-Tolerant Mechanism for Distributed File Cache Consistency", 1989), of the Kubernetes `coordination.k8s.io/v1` `Lease`, and of etcd, whose `concurrency.Session` closes its `Done()` channel when the lease is lost. Hazelcast calls the loss "ownership lost", in `LockOwnershipLostException`. The split of `LeaseController` and `Lease` is the split of the Web `AbortController` and `AbortSignal`, and of Go `context.WithCancelCause`, which gives a context and a cancel function that records a cause.

A lease and fencing answer two different questions. A lease answers the holder: "Do I still have the right?" A fencing token answers a protected resource: "Does this write come from the newest holder?" Each one exists without the other:

- A lease with no fencing: the leader election of Kubernetes client-go. Its documentation says that it "does not guarantee that only one client is acting as a leader (a.k.a. fencing)". Redlock also gives a lock with no token.
- Fencing with no lease: Kafka refuses a producer with an older epoch, and STONITH stops a node by its power.
- An election of zukhruf gives a term with an epoch, and it gives no fencing token.

Thus a lease is in this package, and fencing tokens are in `@zukhruf/fencing`.

## Considered Options

- **Keep the copies.** The names already went apart: `LockLostError` in two packages, `TermLostError` in the third. A catch with `instanceof` must know each issuer. A fix in one copy does not get to the others.
- **One package with leases and fencing tokens.** etcd puts the session and the revision of a key in one `concurrency` package, and Hazelcast puts its `FencedLock` in one `cp.lock` package. Then an election, which has no fencing token, depends on the code of fencing tokens and of the files that keep them.
- **Two packages: a lease here, fencing tokens in `@zukhruf/fencing`.** This option was selected.

## Consequences

- This package has no dependencies. `@zukhruf/fencing` will depend on it, for a lease that also carries a token.
- `LockLostError` of the mutex and `TermLostError` of the election become `LeaseLostError`. The subject of the mutex is the key. The subject of the election is its leadership.
- A lease lasts for a session, not for a time. Thus the package has no timer and no renew. An issuer decides when a lease is lost.
- The package has no events. A holder listens to the `abort` event of the signal.
