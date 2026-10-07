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
The proof that a caller holds a key. A lease has a fencing token and a signal. The signal aborts when the lock store may grant the key to another holder.
_Avoid_: Ticket

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
The set of callers that can share a lock. The reach is one of: instance, process, process tree, host.
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

**Presence**:
The kernel lock that a holder or a waiter of a file lock store keeps while it runs. A waiter that can take the presence of another caller knows that the caller stopped.
_Avoid_: Liveness check, heartbeat, process check

### Fencing

**Fencing token**:
A number that each lease carries. Each grant of a key has a higher number than all earlier grants of that key.
_Avoid_: Version, revision, lock ID, UUID

**Token source**:
The thing that makes fencing tokens for a lock store.
_Avoid_: Counter, generator

**Fenced resource**:
A resource that refuses a write with a fencing token lower than the highest token it has seen.
_Avoid_: Guarded store, protected resource

**Stale holder**:
A holder that lost its key without knowing it, for example while it was frozen.
_Avoid_: Zombie, expired holder

**Lost lease**:
A lease whose key the lock store may have granted to another holder while the first holder still worked. The signal of a lost lease aborts.
_Avoid_: Stolen lock, broken lock

### Coordination

**Coordinator**:
A process that keeps the locks in its memory and grants keys to other processes.
_Avoid_: Lock server, broker, master

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

**Epoch**:
The number of a leader's term. Each new leader has a higher epoch than all earlier leaders.
_Avoid_: Generation, term number

**Failover**:
A new leader replaces a leader that stopped.
_Avoid_: Switchover, handover

**Grace window**:
The time after a failover when the new leader grants no keys.
_Avoid_: Cooldown, quiet period

**Reassert**:
After a failover, a holder tells the new leader which keys it holds.
_Avoid_: Reclaim, re-acquire
