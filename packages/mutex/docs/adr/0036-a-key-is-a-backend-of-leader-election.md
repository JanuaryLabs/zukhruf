# A key is a backend of leader election

Status: Accepted 2026-11-27 (backlog #5427).

Decision-makers: the zukhruf session 76e31f63 decided the mapping from the rules of `LeaderElection` and the sources of the leading systems below. Ezz approved the API paper and the build plan of #5427 with "Sure, go build it", and decided the split on the consumers: "I want the proper one. don't care about consumers now. no backward comapility. we need to force them into our proper std."

[Election ADR 0011](../../../election/docs/adr/0011-a-leader-selector-runs-a-task-each-time-it-wins-a-term-of-a-leader-election.md) moved `LeaderSelector` into `@zukhruf/election`, where it leads over a `LeaderElection` only. The selector of [ADR 0034](./0034-a-leader-selector-of-the-mutex-runs-a-task-each-time-it-leads-and-requeues-as-apache-curator-does.md) also led over a key of the mutex, and datahub's writer leads over a key of `SqlServerStore` ([ADR 0035](./0035-a-sql-server-key-is-a-lease-that-ends-unless-its-holder-renews-it.md)). Thus a key must be a backend of `LeaderElection`. The leading systems keep the election over a lock abstraction, with the lock as one backend (sources read on 2026-11-27):

- Kubernetes client-go: `LeaderElector` runs over `resourcelock.Interface`, "a common interface for locking on arbitrary resources used in leader election" (`resourcelock/interface.go:76-100`). `LeaseLock` is one backend of it (`:104`).
- Spring Integration: `LockRegistryLeaderInitiator` gets its lock from a `LockRegistry` with `obtain(lockKey)` (`LockRegistryLeaderInitiator.java:337`), and leads while `tryLock` holds it (`:387`).
- Apache Curator: `LeaderSelector` leads over an `InterProcessMutex` (`LeaderSelector.java:44`, `:71`, `:161`).

Two facts of this package set the shape. Only `Mutex` and the acquire modes call a lock store ([ADR 0006](./0006-acquire-modes-are-strategies-over-two-store-operations.md)). `Key.run` holds the key for the life of one task, and only the mutex releases it (`src/mutex/key.ts`, `src/mutex/mutex.ts`).

## Decision

The root `@zukhruf/mutex` exports `MutexElection`, a subclass of `LeaderElection`. `new MutexElection({ key, clock })` takes a `Key` of any acquire mode. Its name is the name of the key. The election's attempt holds the key in the task of `Key.run`, and the task waits on a latch until the term gives the key up (`KeyHold` in `src/mutex-election/key-hold.ts`). Each step of `LeaderElection` maps to the key:

| Step                  | On a key                                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`                | A new `KeyAttempt`, with no call to the lock store.                                                                                                                                                                          |
| `tryClaim`            | The grant that the last wait got, or else one try of the key with `SkipIfBusyMode`, which is one `tryAcquire`. Without a grant, it gives `undefined`. The epoch is `lease.token.value`, and `afterCleanShutdown` is false.   |
| `waitForChange`       | Waits in the line of the key with `WaitMode` under the signal of the wait, and keeps the grant for the next try. At an abort it rejects with `signal.reason`, which the campaign ignores. A grant after the abort goes back. |
| `watch`               | Calls `lose` with the reason of the lease's signal when it aborts, and at once when it already aborted ([ADR 0013](./0013-a-lost-lease-aborts-the-signal-of-the-lease.md)).                                                  |
| `recordCleanShutdown` | Does nothing.                                                                                                                                                                                                                |
| `release`             | Lets the task return, so the mutex releases the key. A failed release of the lock store rejects the resign. A loss of the lease while the key is given up is no failure.                                                     |
| `close`               | The same give-up, once: after a release it does nothing, and after a loss or a failed step it gives the grant back.                                                                                                          |

- **The election picks the acquire mode of each step**, so the mode of the key does not count. The wait cannot be in `tryClaim`: the campaign gives `tryClaim` the caller's signal only, with no deadline (`campaign` in `packages/election/src/leader-election.ts`), so `campaign({ timeout: 0 })` would wait. `waitForChange` gets the deadline.
- **The epoch is the fencing token of the grant** ([ADR 0003](./0003-a-fencing-token-on-every-lease.md)). The first rule of `LeaderElection` asks only that each epoch be higher than every earlier one, since election ADR 0011 moved the bound below 2^31 into `SqliteElection`. A token grows with each grant of the lock store, also to a holder that is not a candidate. Across restarts it grows as far as the token source of the lock store does: a durable file counter (`FileTokenSource`), a SQL sequence, `EpochTokenSource`, or a counter of one process (`MemoryStore`). A token of a `SocketStore` is `epoch << 32 | sequence`, which is 2^32 or more, and it leads as any other.
- **`afterCleanShutdown` is always false.** A key keeps no state but its lock, so it has no place for the note. The second rule of `LeaderElection` holds: a backend that records nothing reports nothing. The cost is safe: each next leader recovers. client-go's `LeaderElectionRecord` (`resourcelock/interface.go:46-60`), Curator and Spring have no note of a clean shutdown either. ADR 0018 is about the coordinator of the socket lock store, not about a key.
- **What does not map.** The name is not an identity across lock stores: two keys with one name on two lock stores are two elections, and a `Key` does not expose its store. `lastEpoch()` and `observe()` stay with `SqliteElection`. The third rule (an old leader stops before a new one starts) holds only as far as the lease of the lock store keeps it, as for each backend that loses by time (election ADR 0001): `SqlServerStore` aborts the lease at a failed renewal, and a waiter takes the key after its duration (ADR 0035).

## Considered Options

- **`MutexElection` over a `LockStore`.** The election would call the lock store itself, which ADR 0006 refuses. It would also lose the give-back of a grant that comes after a cancel (`giveBack` in `src/mutex/mutex.ts`).
- **The mode of the key for each step.** A key whose mode waits would make `campaign({ timeout: 0 })` wait. A key whose mode skips would try again and again in a busy loop while the key is held.
- **A `release` that reports each failure, and a `close` that ignores only the loss**, as the API paper of #5427 first gave it. A loss that comes between the start of a resign and the end of the task would then reject the resign, and a `LeaderSelector` would end with a `LeaseLostError` after it gave the key up. A `Term` already ignores a loss after its resign began (`#lose` in `packages/election/src/term.ts`). Thus both steps do one give-up.
- **The name `KeyElection`**, as client-go's `LeaseLock` names its resource. A `Key` is a handle, not a family of lock stores. Spring names its initiator after the lock abstraction that it runs over, `LockRegistry`, so the name is `MutexElection`.

## Consequences

- A `LeaderSelector` of `@zukhruf/election` leads over a key through a `MutexElection`. The task gets a `Term` in place of the `FencedLease`. The signal of the term aborts with a `LeaseLostError` of the term, whose `cause` is the loss of the lease.
- The selector no longer joins the line of the key in the same turn as `start`: the campaign first opens its attempt. A caller that acquires the key right after `start` can get it first. The old test "the selector joins the line of the key before start returns" has no successor.
- After a loss, a failed release of the lock store is a `TermWarning` of `@zukhruf/election`, because no caller waits for it.
- ADR 0034 is superseded by election ADR 0011, and [ADR 0002](./0002-election-is-not-part-of-the-mutex.md) is true again: `Mutex`, `Key` and the lock stores do not know the election.
- datahub's writer moves from the selector of this package to a `LeaderSelector` over a `MutexElection` (#5427, step D).

## Confirmation

- `src/mutex-election.test.ts` tests the election through the exports of the package, over a `MemoryStore` that can lose a lease and fail a try, a wait or a release: a lost lease ends the term; a grant whose lease was already lost is no term; `campaign({ timeout: 0 })` against a busy key resolves `undefined` at once, also when the key's mode waits; a campaign behind a holder waits in the line of the key whatever the key's mode, with one try and one wait; a deadline or a caller that stops the wait leaves the key to the next holder, also when the lock store grants after the cancel; a failed try or wait rejects the campaign; a failed release rejects the resign with that failure, once; a loss during the resign is no failure; after a loss, a failed release is a `TermWarning`; the epochs are the tokens of an `EpochTokenSource` of epoch 7, around the token of a plain holder; `afterCleanShutdown` is false after a clean resign. A `LeaderSelector` over a `MutexElection` warns with `election: <key>`, and leads again with a higher epoch after a lost lease. Over two `SocketStore`s of one folder, two selectors lead one at a time, and the dispose of the leader hands the key to the other.
- `src/import-paths.test.ts`: the root import path has `MutexElection`, and no `LeaderSelector` or `LeaderSelectorWarning`.
- The leaders' sources are the files of the research of session 76e31f63: client-go `resourcelock/interface.go`, Spring `LockRegistryLeaderInitiator.java` and Curator `LeaderSelector.java`.
