# Election

Candidates campaign for one claim. The candidate that wins it is the leader for one term. Each term has an epoch that is higher than the epoch of each earlier term. A term is a lease on leadership, as `@zukhruf/lease` defines a lease. A backend decides what the claim is: for example, a SQLite lock on a local file, or a row in a database that the leader must renew.

## Language

**Candidate**:
A process, or a part of a process, that campaigns to lead.
_Avoid_: Node, member, peer

**Campaign**:
The tries of one candidate to win the claim, until it wins or its time is up.
_Avoid_: Vote, poll

**Claim**:
The one thing that only one candidate can hold at a time. The backend decides what it is.
_Avoid_: Lock (a claim can be a row in a database), lease (the term is the lease, not the claim), token

**Attempt**:
The resources that a backend prepares in `open` for a campaign, for example a connection or a file lock. The campaign calls `tryClaim` on one attempt again and again, and `close` frees it after each end: a won term, a lost term, a failure, or no win before the time is up. When the claim is lost before its term begins, the campaign opens a new attempt (`src/leader-election.ts`). `SqliteAttempt` is the attempt of `SqliteElection`: its file lock, and its pipe after a win.
_Avoid_: Try (one call of `tryClaim`), session, connection (an attempt can hold one)

**Leader**:
The candidate that holds the claim. A group has at most one leader at a time.
_Avoid_: Master, primary, coordinator (a coordinator is what some packages build on a leader)

**Term**:
The time that one leader holds the claim. A term is a lease on leadership: its signal aborts when the backend takes the claim away. See the glossary of [@zukhruf/lease](../lease/CONTEXT.md). A term ends when the leader resigns, when its process dies, or when the backend takes the claim away. A term has no fencing token.
_Avoid_: Session, tenure

**Epoch**:
The number of a term. Each term has a higher epoch than all the terms before it, and the epoch is below 2^31. A fencing token can carry it: `EpochTokenSource` of `@zukhruf/fencing` makes tokens from it, so a newer leader always outranks an older one.
_Avoid_: Generation, version, revision

**Resign**:
The leader ends its term on purpose and gives the claim up.
_Avoid_: Release (the backend releases the claim when the leader resigns), step down

**Clean shutdown**:
A resign in which the leader says that it leaves nothing for the next term to recover, for example no work in progress. The backend records it while the term still holds the claim. Only the next term reads it, as `afterCleanShutdown`. A crash, a lost term, and a resign without `clean` are not a clean shutdown.
_Avoid_: Graceful shutdown, handover

**Lost term**:
A term that ended while its leader still ran: the backend took the claim away, for example because the leader did not renew it in time. A lost term is a lost lease of `@zukhruf/lease`: the signal of the term aborts with `LeaseLostError`, and its subject is `'leadership'`.
_Avoid_: Expired, revoked

**Backend**:
A subclass of `LeaderElection` that implements one kind of claim. `SqliteElection` is the backend of this package.
_Avoid_: Driver, adapter, provider

## Language of a hung leader

These words tell how a candidate waits on the leader, and how a hung leader is found and ended (backlog #4371, ADRs 0004 to 0009).

**Hung leader**:
A leader whose process lives but does not run: `SIGSTOP` stopped it, or its event loop is blocked. It keeps the claim, it sends no heartbeat, and the kernel keeps its pipe open. A process that waits for a slow helper while its event loop runs is not a hung leader.
_Avoid_: Frozen, stuck, dead (a dead leader frees the claim)

**Pipe**:
The local endpoint of `@zukhruf/pipes` that a leader of `SqliteElection` serves for its term. Each reader holds a connection to it. Its close is the push that tells a reader that the leader left. See the glossary of [@zukhruf/pipes](../pipes/CONTEXT.md).
_Avoid_: Socket, channel

**Reader**:
A process that holds a connection to the leader's pipe: a candidate that waits for the claim, or an observer. A reader keeps the deadline of the heartbeat, and it ends a hung leader.
_Avoid_: Watcher (`watch` is the step that watches a won claim), client, listener

**Push**:
An event that the leader's side sends to a reader: a heartbeat, or the close of the pipe. A reader waits on pushes, not on a period. etcd's watch and ZooKeeper's watch are pushes.
_Avoid_: Notify, wake, signal (a signal is an `AbortSignal`)

**Heartbeat**:
One byte that the leader sends on each connection to its pipe: when it accepts the connection, and then every heartbeat interval. A reader finds no meaning in its value.
_Avoid_: Ping, keepalive, tick

**Renew**:
The leader renews its term when it sends its heartbeats. Kubernetes's word for the holder of a Lease.
_Avoid_: Refresh, extend

**Heartbeat interval**:
The time between two heartbeats of the leader. It defaults to a third of the lease duration. etcd's `heartbeat-interval`.
_Avoid_: Retry period (nothing tries again on a period), poll interval, tick

**Lease duration**:
The longest silence that a reader accepts from the leader before it treats the leader as hung. The leader chooses it, and the leader record holds it. Kubernetes's `LeaseDuration`.
_Avoid_: TTL, timeout (the timeout is the time of one campaign), election timeout

**Deadline of the heartbeat**:
The time at which a reader treats the leader as hung: the lease duration after its connect, and again after each heartbeat. etcd's client keeps such a deadline for each lease.
_Avoid_: Expiry, timeout

**Leader record**:
The file `<claimFile>.leader` that the winner of a claim writes before its term begins: the epoch of the term, the process id of the leader, the address of its pipe, and its lease duration. client-go's leader election record.
_Avoid_: Lease (the term is the lease), lock file, pid file

**Back-off**:
The wait of a reader after a connect that found no pipe, while a new leader starts or under a published leader. It grows from 25 ms by 1.6 times, with a jitter of ±20 %, to at most 1000 ms. gRPC's connection backoff. The only wait of a candidate that no push ends.
_Avoid_: Retry period, poll interval, delay

**Observer**:
A `LeaderObserver`: a reader that never tries the claim. `SqliteElection#observe()` makes one for one term. etcd's `Election.Observe`.
_Avoid_: Follower (a follower is a process of the mutex or the single flight that uses an observer), watcher, standby
