# Lease

One holder has the right to act for a subject. An issuer gives that right as a lease. The lease tells the holder when another holder may have the right. The lease does not stop a holder that still acts after that. A fencing token does that, and it is a different concept.

## Language

**Lease**:
The right of one holder to act for a subject, as the holder sees it: a signal. The signal aborts when the lease is lost.
_Avoid_: Lock (a lock is one issuer of leases), ticket, tenure

**Holder**:
The code that has a lease and acts for its subject until the signal aborts.
_Avoid_: Owner, client

**Issuer**:
The code that gives the lease to the holder and keeps its `LeaseController`. For example: a lock store of `@zukhruf/mutex`, or a backend of `@zukhruf/election`.
_Avoid_: Grantor, provider

**Subject**:
The name of the thing that a lease gives the right to. For example: a key of the mutex, or the leadership of an election.
_Avoid_: Resource (a fenced resource is a different thing), key (a key is one kind of subject)

**Lost lease**:
A lease whose holder may not have the right now, because another holder may have it. The issuer decides this. The signal aborts one time, with `LeaseLostError`.
_Avoid_: Expired (no timer ends a lease), revoked, stolen

**Release**:
The holder gives the right up on purpose.
_Avoid_: Unlock, resign (an election uses resign for its leader)

**End**:
The issuer ends the lease after a release. The signal does not abort. A loss after the end does nothing: the holder gave the right up, so it cannot lose it.
_Avoid_: Close, cancel (a cancel stops a wait)

**Session**:
The life of the holder's process, or of its connection to an issuer. A lease of zukhruf lasts for a session, not for a time. It ends when the holder releases it, or when the holder's process stops: the operating system then frees the claim of that process. It is lost when the issuer decides that another holder may have the right, for example after the connection to a coordinator stops. No timer ends a lease, and the holder does not renew it.
_Avoid_: TTL, heartbeat, keep-alive
