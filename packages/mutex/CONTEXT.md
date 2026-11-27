# Mutex

A mutex lets one holder at a time do work on a key. The mutex keeps no locks itself: a lock store keeps them, and the lock store sets who can share them.

## Language

### Holding a key

**Mutex**:
The object that runs a task while the caller holds a key. It gets each lease from a lock store.
_Avoid_: Lock, lock manager

**Key**:
The thing that only one holder at a time can work on, identified by its name. A key can have a default acquire mode.
_Avoid_: Resource name, lock name, lock ID

**Acquire**:
A caller asks for a key. The caller waits until the lock store grants the key.
_Avoid_: Lock (as a verb), take

**Grant**:
The lock store gives a lease for a key to one waiter.
_Avoid_: Allow, assign

**Release**:
The mutex gives the key back when the task ends, so that the next waiter can get it. Only the mutex releases a key.
_Avoid_: Unlock, free

**Lease**:
The proof that a caller holds a key. The lease of a mutex is a fenced lease: it has a fencing token and a signal. Its subject is the key. The signal aborts when the lock store may grant the key to another holder. See the glossary of [`@zukhruf/lease`](../lease/CONTEXT.md) and of [`@zukhruf/fencing`](../fencing/CONTEXT.md).
_Avoid_: Ticket (the line of a waiter in a queue file)

**Lock handle**:
What a lock store gives the mutex for a granted key: the lease and the release. Only the mutex has the lock handle. The task gets only the lease.
_Avoid_: Lease, guard

**Holder**:
The caller that has the lease for a key now.
_Avoid_: Owner, locker

**Waiter**:
A caller that asked for a key and does not have it yet.
_Avoid_: Contender, pending caller

**Holder check**:
A caller asks whether a key has a holder now. The lock store answers without a grant, so a holder check never makes a key busy for a caller that acquires it. The holder can change before the answer arrives: show the answer, but do not acquire a key because of it.
_Avoid_: Peek, probe, query, try (a try acquires)

**Acquire mode**:
What one caller does while its key is busy. It never changes exclusivity, and two callers of one key can use different acquire modes. A key can have a default acquire mode that one call overrides.
_Avoid_: Lock mode, lock type

**Wait**:
The acquire mode in which the caller waits until the key is granted. The task always runs.
_Avoid_: Block, lock

**Skip if busy**:
The acquire mode in which the caller gives up when the key stays busy, at once or after a time limit. The task then does not run. The time limit counts only the wait for another holder.
_Avoid_: Try-lock, skip after, timeout

**Give up**:
An acquire mode stops a wait. The caller gets `{ acquired: false }`, and the task does not run.
_Avoid_: Cancel, time out

**Cancel**:
A caller stops its own wait with a signal. The call rejects with the reason of the signal, and the task does not run. A cancel stops only the wait: when the caller holds the key, the task runs to its end.
_Avoid_: Give up, abort (the signal aborts; the caller cancels)

### Lock stores and reach

**Lock store**:
The place that keeps the locks for a mutex. Each lock store has a reach.
_Avoid_: Backend, driver, adapter

**Reach**:
The set of callers that can share a lock. The reach is one of: instance, process, process tree, host, network.
_Avoid_: Scope, visibility

**Instance**:
A reach that includes only the callers of one lock store object.
_Avoid_: Local

**Process**:
A reach that includes all threads of one running program.
_Avoid_: Application

**Process tree**:
A reach that includes one parent process and the child processes that it started.
_Avoid_: Cluster, worker pool

**Host**:
A reach that includes all processes on one machine.
_Avoid_: Server, node

**Network**:
A reach that includes all processes on all machines that reach one server, for example one Postgres database, or one Docker engine.
_Avoid_: Distributed, global, cluster, remote

**Session**:
A connection to the server of a network lock store. The server keeps the lock of a key while the session that holds it lasts, and releases the lock when the session ends. `SqlServerStore` keeps no lock on a session: it runs each statement on a session of its own, and its keys are lease rows. For a Docker engine lock store, the session of a holder is its attach to its claim. For a socket lock store, a session is one `SocketStore` object across failovers: a random id, a record in the folder `sessions` of the directory and a presence, from before its first connection until the store is disposed. Each new leader waits for the recorded sessions in its recovery (see [ADR 0033](docs/adr/0033-a-new-leader-grants-nothing-until-each-recorded-session-reasserted-its-keys-stopped-or-missed-its-lease.md)).
_Avoid_: Connection pool, client

**Lease row**:
The row of a key in the table of `SqlServerStore`: the holder ID of the grant, the fencing token, the server's time of the last renewal, and the lease duration. The lease ends when the lease duration passed since the last renewal, on the server's clock, and another store can then take the key. See [ADR 0035](docs/adr/0035-a-sql-server-key-is-a-lease-that-ends-unless-its-holder-renews-it.md).
_Avoid_: Lock row, application lock

**Lease duration**:
The longest silence that the others accept from a holder or a process before it loses what it holds. For `SqlServerStore`, the time since the last renewal of a lease row, on the server's clock; it is longer than two heartbeat intervals, so the holder stops first. For `SocketStore`, the silence after which a follower ends a leader, or a new leader ends the recovery of a session (ADR 0033).
_Avoid_: TTL, timeout

**Claim**:
The named container that holds a key on a Docker engine. Its name comes from the namespace and the key, so one key has at most one claim. The claim lasts while the attach of its holder lasts. When the attach ends, the claim stops and the engine removes it.
_Avoid_: Lock container, lock file, marker

**Heartbeat**:
A short query that the session of a holder sends at a fixed interval, with a time limit. It asks whether the session still holds the lock of its key. For a Docker engine lock store, the heartbeat is an inspect of the claim. For `SqlServerStore`, the heartbeat is the renewal of the lease row. A failed or late heartbeat tells the network lock store that the session ended, and the lease is lost.
_Avoid_: Ping, keep-alive (TCP keep-alive is a different mechanism), presence

**Presence**:
The kernel lock that a holder or a waiter of a file lock store, or a session of a socket lock store, keeps while it runs: a `Presence` of `@zukhruf/fs` (its ADR 0007). `CallerPresence` (`src/lock-stores/file-system/caller-presence.ts`) is the presence of a caller of a file lock store. A waiter that can take the presence of another caller knows that the caller stopped. A new leader of a socket lock store that finds the presence of a session free knows that the session stopped.
_Avoid_: Liveness check, heartbeat, process check

**Ticket**:
The line that a waiter of `TicketQueueFileStore` appends to the queue file of its key: one line of JSON with a process ID, a host name and a unique ID. The waiter whose ticket is first holds the key. The holder removes its ticket when it releases the key (`src/lock-stores/file-system/ticket-queue-file-store.ts`).
_Avoid_: Lease (the proof that a caller holds a key), entry

**Reclaim**:
A waiter of a file lock store removes a holder that stopped, so that a waiter can get the key. Before it removes the holder, the waiter takes the reclaim lock, a kernel lock on `<key>.lock.reclaim`. Only one waiter at a time has it, and the kernel ends it when that waiter stops. Without it, two waiters could each remove a lock that the other had just taken (`withReclaimLock` in `src/lock-stores/file-system/file-lock-store.ts`, `src/lock-stores/file-system/reclaim-lock.test.ts`).
_Avoid_: Reassert (a holder of a socket lock store tells a new leader its keys), steal

**Namespace**:
The first part of the name of each claim and each rung of a Docker engine lock store, and the value of the label `zukhruf.mutex.namespace` on them. Docker engine lock stores with one namespace on one engine share their locks (`namespace` of `DockerEngineStoreOptions`).
_Avoid_: Prefix, scope

**Lock-store contract**:
The rules that each lock store must satisfy, in `src/testing/contract/`, one function for each group of rules. Each lock store calls the functions for its capabilities from its own `<store>.contract.test.ts`. See [ADR 0030](docs/adr/0030-each-lock-store-runs-the-lock-store-contract-from-its-own-tests-and-a-capability-is-a-typed-parameter.md).
_Avoid_: Shared suites, store cases (the table that ADR 0030 removed)

### Fencing

The glossary of [`@zukhruf/fencing`](../fencing/CONTEXT.md) defines the fencing terms, and the glossary of [`@zukhruf/lease`](../lease/CONTEXT.md) defines the lost lease. The entries below tell only what each term means for a mutex.

**Fencing token**:
A number that each lease carries. Each grant of a key has a higher number than all earlier grants of that key. See `@zukhruf/fencing`.
_Avoid_: Version, revision, lock ID, UUID

**Token source**:
The object that makes the fencing tokens of a lock store. See `@zukhruf/fencing`.
_Avoid_: Counter, generator

**Mint**:
The step in which a lock store gets the fencing token of a granted key. A network lock store mints with its session, for example `nextval` of a sequence on Postgres. A failed mint releases the key, so the acquire rejects and the key stays free (`src/lock-stores/memory/memory-store.test.ts`). See [ADR 0019](docs/adr/0019-a-failed-token-mint-answers-the-request-and-an-exhausted-epoch-ends-the-term.md).
_Avoid_: Generate, issue

**Ladder**:
The named volumes that give the fencing tokens of a Docker engine lock store. Each volume is a rung, and the number in its name is a token. To get a token, a holder creates the rung with the higher of two numbers: the engine time of its claim in microseconds, and the highest rung + 1. Then it removes the lower rungs. The engine time keeps the tokens higher than all earlier tokens when somebody removes the ladder.
_Avoid_: Sequence, counter volume

**Fenced resource**:
A resource that refuses a write with a fencing token lower than the highest token it has seen. See `@zukhruf/fencing`.
_Avoid_: Guarded store, protected resource

**Stale holder**:
A holder that lost its key without knowing it, for example while it was frozen. See `@zukhruf/fencing`.
_Avoid_: Zombie, expired holder

**Lost lease**:
A lease whose key the lock store may have granted to another holder while the first holder still worked. The signal of a lost lease aborts with `LeaseLostError`. See `@zukhruf/lease`.
_Avoid_: Stolen lock, broken lock

### Coordination

**Coordinator**:
A process that keeps the locks in its memory and grants keys to other processes.
_Avoid_: Lock server (the server that serves the coordinator), broker, master

**Lock server**:
The server that the leader of a socket lock store starts for its term. It serves the coordinator on a Unix socket, and its fencing tokens carry the epoch of the term. When the term is lost, the lock server closes itself (`LockServer` in `src/lock-stores/socket/lock-server.ts`, `src/lock-stores/socket/lock-server.test.ts`).
_Avoid_: Coordinator (the coordinator keeps the locks; the lock server serves it), broker

**Candidate**:
A process that can become the leader.
_Avoid_: Node, peer

**Campaign**:
One attempt by a candidate to become the leader.
_Avoid_: Election round, vote

**Leader**:
The candidate that won the election and is the coordinator now.
_Avoid_: Master, primary

**Follower**:
A candidate that uses the current leader as its coordinator.
_Avoid_: Client, replica, slave

**Term**:
The time during which one candidate is the leader. A term ends when the leader resigns, when its process dies, or when its epoch has no fencing tokens left. When its term ends, the leader stops its server. See the glossary of [`@zukhruf/election`](../election/CONTEXT.md).
_Avoid_: Tenure

**Epoch**:
The number of a leader's term. Each new leader has a higher epoch than all earlier leaders.
_Avoid_: Generation, term number

**Failover**:
A new leader replaces a leader that stopped or lost its term. A follower stops a leader that sent no heartbeat for longer than its lease duration (see `@zukhruf/election`), so a frozen leader is replaced too.
_Avoid_: Switchover, handover

**Recovery**:
The phase after a failover in which the new leader grants no keys. It ends when each recorded session reasserted its keys and sent the end-of-reasserts marker, stopped, or missed its lease duration. The first leader of a directory, and a new leader after a clean shutdown (see `@zukhruf/election`), have no recovery. The word is the one of PostgreSQL's crash recovery. See [ADR 0033](docs/adr/0033-a-new-leader-grants-nothing-until-each-recorded-session-reasserted-its-keys-stopped-or-missed-its-lease.md).
_Avoid_: Grace window (the fixed time that ADR 0033 removed), cooldown, quiet period

**Reassert**:
After a failover, a holder tells the new leader which keys it holds. Then it sends the end-of-reasserts marker, `{"op":"reasserted"}`, also when it holds no key.
_Avoid_: Reclaim (a waiter of a file lock store removes a holder that stopped), re-acquire

**Protocol version**:
The number of the message format between the processes of a socket lock store and their leader. Each process sends it in its `hello` before its first request. A leader refuses a process with another protocol version, and the acquire fails with `ProtocolVersionError`. See [ADR 0014](docs/adr/0014-a-process-says-its-protocol-version-before-its-first-request.md).
_Avoid_: Package version (each new package version would then refuse all earlier ones)

### Leading with a key

**Mutex election**:
`MutexElection`. A backend of `LeaderElection` of `@zukhruf/election` over a key: the holder of the key leads, and the epoch of a term is the fencing token of its grant. The election picks the acquire mode of each step of a campaign, and records no clean shutdown. A `LeaderSelector` of `@zukhruf/election` runs a task each time this process leads over it. The name follows Spring's `LockRegistryLeaderInitiator`, which names its initiator after the lock abstraction. See [ADR 0036](docs/adr/0036-a-key-is-a-backend-of-leader-election.md).
_Avoid_: Key election (a key is a handle, not a family of lock stores), leader selector of the mutex (ADR 0034, superseded)
