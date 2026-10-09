# Election

Candidates campaign for one claim. The candidate that wins it is the leader for one term. Each term has an epoch that is higher than the epoch of each earlier term. A backend decides what the claim is: for example, a SQLite lock on a local file, or a lease in a database.

## Language

**Candidate**:
A process, or a part of a process, that campaigns to lead.
_Avoid_: Node, member, peer

**Campaign**:
The tries of one candidate to win the claim, until it wins or its time is up.
_Avoid_: Vote, poll

**Claim**:
The one thing that only one candidate can hold at a time. The backend decides what it is.
_Avoid_: Lock (a claim can be a lease), token

**Leader**:
The candidate that holds the claim. A group has at most one leader at a time.
_Avoid_: Master, primary, coordinator (a coordinator is what some packages build on a leader)

**Term**:
The time that one leader holds the claim. A term ends when the leader resigns, when its process dies, or when the backend takes the claim away.
_Avoid_: Session, lease

**Epoch**:
The number of a term. Each term has a higher epoch than all the terms before it, and the epoch is below 2^31. A fencing token can carry it, so a newer leader always outranks an older one.
_Avoid_: Generation, version, revision

**Resign**:
The leader ends its term on purpose and gives the claim up.
_Avoid_: Release (the backend releases the claim when the leader resigns), step down

**Lost term**:
A term that ended while its leader still ran: the backend took the claim away, for example because a lease expired. The signal of the term aborts with `TermLostError`.
_Avoid_: Expired, revoked

**Backend**:
A subclass of `LeaderElection` that implements one kind of claim. `SqliteElection` is the backend of this package.
_Avoid_: Driver, adapter, provider
