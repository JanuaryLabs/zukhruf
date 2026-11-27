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
The number of a term. Each term has a higher epoch than all the terms before it. A fencing token can carry it: `EpochTokenSource` of `@zukhruf/fencing` makes tokens from an epoch below 2^31, so a newer leader always outranks an older one. Each epoch of `SqliteElection` is below 2^31 (ADR 0011).
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

**Name**:
The identity of an election in its backend: `LeaderElection#name`. Two elections with the same name are the same election. The backend derives it from its claim. The name of a `SqliteElection` is the path of its claim file. Hazelcast's `DistributedObject.getName()`, Redisson's `RObject.getName()` (ADR 0010).
_Avoid_: Key (etcd's `Election.Key()` is the key of one candidate), ID, identity (client-go's `Identity()` is the holder)

## Language of a leader selector

These words tell how a process runs a task each time it leads (ADR 0011).

**Leader selector**:
`LeaderSelector`. It runs a task each time this process wins a term of a `LeaderElection`, and resigns the term when the task ends. With `autoRequeue`, a new round starts after each round, until the dispose. The name is the one of Apache Curator's `LeaderSelector`. See [ADR 0011](docs/adr/0011-a-leader-selector-runs-a-task-each-time-it-wins-a-term-of-a-leader-election.md).
_Avoid_: Hold for life, lease scope (coined names that mutex ADR 0034 rejected), leader initiator (Spring's name for the same loop), elector (client-go's name), singleton

**Round**:
One campaign with no time limit, one call of take leadership with the term, and one resign of the term.
_Avoid_: Cycle, iteration, attempt (an attempt is the resources of one campaign)

**Take leadership**:
The task of a leader selector, `listener.takeLeadership(term, signal)`. It runs while the term lasts, and gives the leadership up when it returns or rejects with `signal.reason`. Its signal aborts at the dispose, at `interruptLeadership()`, and when the term is lost. A rejection with another error ends the selector, unless the term was lost.
_Avoid_: On granted, on revoked (Spring's two callbacks split one task), on started leading (client-go's callback), job

**Requeue**:
To queue one more round of a leader selector. `requeue()` queues one, and returns false while a round is queued or runs. With `autoRequeue`, the selector requeues after each round by itself: at once after a task that ended or a lost term, and after the wait of its `backoff` on its clock after a failed campaign.
_Avoid_: Retry (a requeue also follows a task that ended well), restart, re-elect

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
The wait of a reader after a connect that holds no connection to a leader's pipe: no leader serves one yet (a new leader starts, or a published one leads), the pipe is another user's, or its listen queue is full (#5425). It grows from 25 ms by 1.6 times, with a jitter of ±20 %, to at most 1000 ms. gRPC's connection backoff. The only wait of a candidate that no push ends.
_Avoid_: Retry period, poll interval, delay

**Observer**:
A `LeaderObserver`: a reader that never tries the claim. `SqliteElection#observe()` makes one for one term. etcd's `Election.Observe`.
_Avoid_: Follower (a follower is a process of the mutex or the single flight that uses an observer), watcher, standby
