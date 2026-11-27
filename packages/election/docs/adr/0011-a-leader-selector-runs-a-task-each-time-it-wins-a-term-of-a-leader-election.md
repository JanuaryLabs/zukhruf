# A leader selector runs a task each time it wins a term of a leader election

Status: Accepted 2026-11-27 (backlog #5427).

Decision-makers: the zukhruf session 76e31f63 decided from the sources of the leading systems below. Ezz decided the split on the consumers: "I want the proper one. don't care about consumers now. no backward comapility. we need to force them into our proper std." He approved the build plan with "Sure, go build it", which also moved the epoch bound into `SqliteElection` (option (b) of the open question of the API paper).

[Mutex ADR 0034](../../../mutex/docs/adr/0034-a-leader-selector-of-the-mutex-runs-a-task-each-time-it-leads-and-requeues-as-apache-curator-does.md) put `LeaderSelector`, a copy of Apache Curator's `LeaderSelector`, into `@zukhruf/mutex`. It led over a key of the mutex or over a `LeaderElection` of this package. The owner loop of `@zukhruf/pool` (`#live` in `packages/pool/src/pool-workers.ts`) is one of the three hand-written loops that the selector replaces (#5408). The pool cannot use it there:

- `@zukhruf/pool` and `@zukhruf/mutex` are both domain packages (`std:domain`).
- [Root ADR 0001](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md), rule 5: "A domain package never imports another domain package in its shipped code."

Thus the placement of mutex ADR 0034 stops the switch of the pool. This package is the coordination layer (`std:coordination`), which each domain package can import, and its shipped code imports only base packages (`eslint.config.mjs`, `LAYERS`).

The leading systems put the loop with the leader election, over one abstraction of the election, and never in the lock package (sources read on 2026-11-27):

| System                                                          | The loop                                                                                                                                                                                                                                                       | Over what                                                                                                                                                                          |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kubernetes client-go `tools/leaderelection`                     | `LeaderElector.Run` acquires, runs `OnStartedLeading(ctx)`, and renews. A failed acquire tries again each `RetryPeriod` with jitter (`leaderelection.go:361-375`, `wait.JitterUntilWithContext`). "Core clients default this value to 2 seconds" (`:156-160`). | `resourcelock.Interface`, "a common interface for locking on arbitrary resources used in leader election" (`resourcelock/interface.go:76-100`), with backends such as `LeaseLock`. |
| Apache Curator `recipes.leader.LeaderSelector`                  | `doWork` acquires its mutex, calls `takeLeadership`, and releases. "autoRequeue should ignore connection loss or session expired and just keep trying" (`LeaderSelector.java:481-482`).                                                                        | An `InterProcessMutex` of `recipes.locks` (`:44`, `:71`, `:161`). The selector is in the leader recipes, not in the locks.                                                         |
| Spring Integration `support.leader.LockRegistryLeaderInitiator` | `while (isRunning())`: `tryLock`, then `onGranted`, and a sleep of `busyWaitMillis` before the next try (`LockRegistryLeaderInitiator.java:436-448`).                                                                                                          | A `LockRegistry` of `support.locks` (`:29`, `:68`), whose `obtain(lockKey)` gives the lock (`:337`).                                                                               |
| etcd `client/v3/concurrency`                                    | `Election.Campaign` and `Mutex.Lock` are two siblings over one `Session` (`election.go:32-44`, `mutex.go:36-45`). The election does not import the mutex. A term is the `int64` revision of the leader key: `Rev() int64` (`election.go:251`).                 | A `Session`, which is a lease.                                                                                                                                                     |
| HashiCorp Consul `api.Lock`                                     | The lock is over a `Session` (`lock.go:63`, `:102`).                                                                                                                                                                                                           | A `Session`.                                                                                                                                                                       |

No standard library of Go or .NET has a leader selector.

## Decision

This package exports `LeaderSelector`, `LeaderSelectorListener`, `LeaderSelectorOptions` and `LeaderSelectorWarning`. `LeaderSelector.start(election, listener, options)` leads over a `LeaderElection` only, as client-go's `LeaderElector` leads over `resourcelock.Interface`. A round campaigns with no time limit, gives the task the `Term`, and resigns the term after the task.

```ts
interface LeaderSelectorListener {
  /** Return, or reject with `signal.reason`, to give the leadership up. */
  takeLeadership(term: Term, signal: AbortSignal): Promise<void>;
}

interface LeaderSelectorOptions {
  autoRequeue?: { backoff: Backoff; clock: Clock } | undefined;
}

class LeaderSelector implements AsyncDisposable {
  static start(
    election: LeaderElection<unknown>,
    listener: LeaderSelectorListener,
    options?: LeaderSelectorOptions,
  ): LeaderSelector;
  get hasLeadership(): boolean;
  get ended(): Promise<void>;
  requeue(): boolean;
  interruptLeadership(): void;
  [Symbol.asyncDispose](): Promise<void>;
}
```

- **What stays from mutex ADR 0034.** The names of Curator, `autoRequeue` with its `Backoff` and `Clock`, `requeue()`, `interruptLeadership()`, `hasLeadership`, `ended`, the dispose that waits, the four states (queued, leading, idle, ended), the table of what comes after each round, and the rule that a task that ends after a loss has a loss. Each divergence from Curator, and its reason, stays as that ADR gives it.
- **What goes.** The overload over a `Key<'always'>` of the mutex, the `Lead` function that hid the two sources, the generic listener, and the `FencedLease` that the task got over a key. The selector no longer knows `@zukhruf/fencing` or the mutex.
- **The warning.** `LeaderSelectorWarning` is a class of this package, in the shape of [root ADR 0010](../../../../docs/adr/0010-a-package-warning-names-its-type-code-and-subject-and-keeps-the-failure-as-its-cause.md) and [root ADR 0011](../../../../docs/adr/0011-a-package-warning-is-an-instance-of-its-own-class-which-the-package-exports.md). Its code is `ZUKHRUF_ELECTION_LEADER_SELECTOR_CAMPAIGN_FAILED`: the project is `election` now, and the step that fails is always a campaign. Its detail is `election: <name>` ([ADR 0010](./0010-an-election-has-a-name-and-the-name-of-a-sqlite-election-is-the-path-of-its-claim-file.md)). Its message is "The campaign failed, and the selector campaigns again: " and the message of the failure.
- **The requeue rule is chosen once.** `start` picks the rule from `autoRequeue`: with it, the selector campaigns again after each term, and after a failed campaign it warns and waits `backoff.duration(retries)` on `clock`; without it, the selector waits for `requeue()` after each term, and a failed campaign ends it. Each rule is a private class, so the count of failed campaigns lives with the back-off that reads it, and no step of the loop asks whether `autoRequeue` was given.
- **The epoch bound moves into `SqliteElection`.** The rules of a backend promise only that each epoch is higher than every earlier one. `SqliteElection` keeps each epoch below 2^31, because its leaders make fencing tokens with `new EpochTokenSource(term.epoch)` of `@zukhruf/fencing` ([ADR 0002](./0002-a-term-is-a-lease-on-leadership-with-no-fencing.md)), which takes an epoch below 2^31 only. When the next epoch would reach 2^31, its campaign rejects with a `RangeError` that names the epoch file, gives the claim up, and does not change the file, as it does for an epoch file that is not decimal digits.

The bound was a fact of `EpochTokenSource`, not of an election. A backend whose claim already has a fencing token, such as a key of the mutex, can give that token as its epoch: on the socket lock store it is `epoch << 32 | sequence`, which is 2^32 or more. etcd uses an `int64` revision as its term, and client-go counts `LeaderTransitions` as an `int` (`resourcelock/interface.go:56`).

## Considered Options

- **Keep the selector in the mutex** (mutex ADR 0034). The pool cannot import it: root ADR 0001, rule 5.
- **Keep the key overload, in this package.** The election would import the mutex, which imports the election (`packages/mutex/package.json`), and the coordination layer would ship a domain package.
- **One selector in each backend package**, as Spring has `zookeeper.leader.LeaderInitiator` beside `LockRegistryLeaderInitiator`. Each package has a copy of the loop, and a fix in one copy does not get to the other.
- **The base keeps the bound below 2^31** (option (a) of the paper). Then no key of the mutex on a socket store can lead, although its token is already a real fence.
- **A term carries a fencing token** (option (c)). It reverses ADR 0002, which gives the reasons against it.

## Consequences

- `@zukhruf/election` gets no new dependency: the selector uses `@zukhruf/async` and `@zukhruf/lease`, which are its dependencies today (`package.json`).
- Mutex ADR 0034 is superseded by this ADR. `@zukhruf/mutex` gives a backend of `LeaderElection` over a key, `MutexElection`, in its own ADR. Until then, the mutex keeps its own selector (#5427, step B removes it).
- The code of the warning changes from `ZUKHRUF_MUTEX_LEADER_SELECTOR_ACQUIRE_FAILED`, and its detail is always `election: <name>`. A consumer that compares the code changes with it. The owner allowed the break: no backward compatibility.
- The pool can run its owner loop in a selector (#5427, step C). With `autoRequeue`, a failed campaign warns and campaigns again, where today it ends the host. A fault that stays, such as the `NetworkDirectoryError` of `SqliteElection`, then warns with no end, so a host checks its directory before the start.
- The recipe [Run a job in only one process](../recipes/run-a-job-in-only-one-process.md) is in this package again. Its program imports only this package and `@zukhruf/async`.
- The tests of the selector that ran over a key of the mutex run over `ScriptedElection`, the backend of `src/leader-election.test.ts`. The copy is in [the copy ledger](../copied-code.md), and #6147 waits for a third place.
- `EPOCH_LIMIT` of `SqliteElection` is a copy of the constant of `EpochTokenSource`. The election does not depend on `@zukhruf/fencing` ([fencing ADR 0001](../../../fencing/docs/adr/0001-a-fencing-token-is-a-number-the-resource-checks.md)), so the tiny copy stays (root ADR 0001, rule 4).

## Confirmation

- `src/leader-selector.test.ts` tests the selector through the exports of the package: over `ScriptedElection` for the failures, the dispose, a lost term, the interrupt, the requeue and the states, and over `SqliteElection` for the term, the resign, the dispose during a campaign behind another leader, and a failed campaign with the warning and its detail.
- `src/sqlite/sqlite-election.test.ts`: an epoch file whose next epoch is 2^31 fails the campaign with a `RangeError` that names the file, leaves the file as it was, and lets the claim go; the epoch 2^31 - 1 still wins its term.
- `npx nx run election:test` on 2026-11-27: 104 tests, 0 failed, 3 skipped (70 before: 32 new tests of the selector and 2 of the bound). Each claim went red before its code, except where the step before already did the work: a selector that ran one round failed the resign, requeue, loss, interrupt and campaign-failure tests, and `SqliteElection` without the bound failed the `RangeError` test ("Missing expected rejection").
- The leaders' sources are the files of the research of session 76e31f63: client-go `tools/leaderelection/leaderelection.go` and `resourcelock/interface.go`, Curator `LeaderSelector.java`, Spring `LockRegistryLeaderInitiator.java`, etcd `concurrency/election.go` and `mutex.go`, and Consul `api/lock.go`.
