# A leader selector of the mutex runs a task each time it leads, and requeues as Apache Curator does

Status: Accepted 2026-11-23 (#5408). The owner ruled on an earlier draft, which named the loop `holdForLife` over a coined `LeaseScope`: "we should not be doing a divergence from the leading tools. Step back and think properly." On the count of places, the owner said: "It counts: extract the loop now". To the question "Where should LeaderSelector live?", the owner chose "@zukhruf/mutex (Recommended)".

Some work must run in only one process of a group, for the whole life of each process. The process waits for exclusivity, runs the work until a loss or a stop, gives the exclusivity up, and waits again. Three places write this loop by hand (#5408):

| Place                                                                                                                                                                 | Exclusivity                         | The loop                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `@zukhruf/pool`, `src/pool-workers.ts:148-167` (`#live`) and `:170-232` (`#own`)                                                                                      | a term of `SqliteElection`          | `while (!stop.aborted)`: `campaign({ timeout: Infinity, signal: stop })`, then `#own(term!, stop)`, which resigns at its end |
| `@zukhruf/election`, its recipe "Run a job in only one process" (now [run-a-job-in-only-one-process.md](../recipes/run-a-job-in-only-one-process.md) of this package) | a term of `SqliteElection`          | `for (;;)`: `campaign({ timeout: 200 })`, the job while `!term.signal.aborted`, `term.resign()`                              |
| datahub, `apps/backend/src/warehouse-writer.ts` and `services/warehouse/writer.ts` (#5408)                                                                            | a key of `Mutex` + `SqlServerStore` | one grant for each fork; the parent forks again after a back-off of 30 s to 15 min                                           |

The leading systems (sources read on 2026-11-23):

| System                                                                                                                                                                                                                                    | The loop                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apache Curator [`LeaderSelector`](https://curator.apache.org/docs/recipes-leader-election)                                                                                                                                                | `doWork` (`LeaderSelector.java:422-467`): `mutex.acquire()` of its `InterProcessMutex`, then `listener.takeLeadership(client)`, then `mutex.release()` in a `finally`. `taskDone` (`:359-378`) requeues only when `autoRequeue()` was called. The listener "should not return until you wish to release leadership" (`LeaderSelectorListener.java`). |
| Spring Integration ZooKeeper `LeaderInitiator`                                                                                                                                                                                            | A Curator `LeaderSelector` with `autoRequeue()` (`ZkLeaderInitiator.java:163-166`), whose `takeLeadership` calls `candidate.onGranted` and then sleeps `Long.MAX_VALUE` (`:241-257`).                                                                                                                                                                |
| Spring Integration [`LockRegistryLeaderInitiator`](https://github.com/spring-projects/spring-integration/blob/main/spring-integration-core/src/main/java/org/springframework/integration/support/leader/LockRegistryLeaderInitiator.java) | Leadership over any `LockRegistry`: `while (isRunning())` it calls `lock.tryLock(heartBeatMillis)`, then `onGranted` or `onRevoked`, and sleeps `busyWaitMillis` after a loss (`:343-413`).                                                                                                                                                          |
| client-go [`leaderelection`](https://github.com/kubernetes/client-go/blob/master/tools/leaderelection/leaderelection.go)                                                                                                                  | `Run` (`:284-303`) acquires once, runs `OnStartedLeading(ctx)`, and returns after a loss. A failed acquire tries again every `RetryPeriod`, with jitter (`:361-377`). `defer runtime.HandleCrashWithContext(ctx)` (`:285`).                                                                                                                          |
| Azure [Leader Election pattern sample](https://github.com/Azure-Samples/cloud-design-patterns) `BlobDistributedMutex.RunTaskWhenMutexAcquiredAsync`                                                                                       | `while (!token.IsCancellationRequested)`: acquire the blob lease or wait, run the task, and cancel it when a renew fails (`BlobDistributedMutex.cs:51-78`). A failure of the task goes only to `Trace.TraceError` (`:25-48`).                                                                                                                        |
| .NET [`BackgroundService`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Hosting.Abstractions/src/BackgroundService.cs)                                                                                  | No loop: it owns one work. `StopAsync` cancels `stoppingToken` and waits for `ExecuteTask` (`BackgroundService.cs:60-86`). A failure stops the host by default (`BackgroundServiceExceptionBehavior.StopHost`, `BackgroundServiceExceptionBehavior.cs:20`).                                                                                          |

Curator's selector sits beside its mutex: acquire, `try { takeLeadership } finally { release }` is `Mutex.acquire(key, task)` of this package (`src/mutex/mutex.ts:84-106`). Spring's ZooKeeper initiator is the same selector with `autoRequeue`. Thus Curator is the design to copy.

## Decision

This package exports `LeaderSelector`, a copy of Apache Curator's `LeaderSelector`. `LeaderSelector.start(source, listener, options)` waits for the leadership of a key of this package or of a `LeaderElection` of `@zukhruf/election`, runs `listener.takeLeadership` while it leads, and gives the leadership up when the task ends. With `autoRequeue`, it waits for the leadership again, until its dispose.

```ts
import type { Backoff, Clock } from '@zukhruf/async';
import type { LeaderElection, Term } from '@zukhruf/election';
import type { FencedLease } from '@zukhruf/fencing';

interface LeaderSelectorListener<L> {
  /** Return, or reject with `signal.reason`, to give the leadership up. */
  takeLeadership(lease: L, signal: AbortSignal): Promise<void>;
}

interface LeaderSelectorOptions {
  /** Without it, the selector leads once and then waits for `requeue()`. */
  autoRequeue?: { backoff: Backoff; clock: Clock } | undefined;
}

class LeaderSelector implements AsyncDisposable {
  static start(
    key: Key<'always'>,
    listener: LeaderSelectorListener<FencedLease>,
    options?: LeaderSelectorOptions,
  ): LeaderSelector;
  static start(
    election: LeaderElection<unknown>,
    listener: LeaderSelectorListener<Term>,
    options?: LeaderSelectorOptions,
  ): LeaderSelector;
  /** True while `takeLeadership` runs. */
  get hasLeadership(): boolean;
  /** Resolves at a clean end, and rejects with the failure that ended the selector. */
  get ended(): Promise<void>;
  /** Queues one more round. False when a round is queued or runs. Throws after the dispose, and after a failure ended the selector. */
  requeue(): boolean;
  /** Aborts the signal of the running task. Does nothing while the selector does not lead. */
  interruptLeadership(): void;
  /** Aborts the selector, and waits for its end. */
  [Symbol.asyncDispose](): Promise<void>;
}
```

A round is one wait for the leadership, one call of `takeLeadership`, and one give-up of the leadership. Over a key, a round is `key.run(task, { signal: stop })`: the mutex waits for the key, gives the task the `FencedLease`, and gives the key up after the task. Over an election, a round is `campaign({ timeout: Infinity, signal: stop })`, the task with the `Term`, and `term.resign()` after the task. The signal of the task is `AbortSignal.any([stop, interrupt, lease.signal])`: it aborts at the dispose, at `interruptLeadership()`, and at a loss ([ADR 0013](./0013-a-lost-lease-aborts-the-signal-of-the-lease.md)). A task that rejects with the reason of that signal after it aborted has no failure. A task that rejects or resolves after a loss has a loss, with the rules of `Mutex.acquire` (`src/mutex/mutex.ts:96-103`).

After each round:

| The round ends because                                          | With `autoRequeue`                                                                                                                                                   | Without `autoRequeue`                                               | Curator                                                                                                                                                                                                                    |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The dispose aborted the selector, in the wait or in the task    | The selector ends, after it gave the leadership up. `ended` resolves.                                                                                                | The same.                                                           | `close()` closes the executor, which cancels the task with an interrupt (`LeaderSelector.java:258-265`, `CloseableExecutorService.java:128-139`).                                                                          |
| The lease was lost, or `interruptLeadership()` aborted the task | The next round starts at once, with no back-off.                                                                                                                     | The selector waits for `requeue()`.                                 | The interrupt ends `takeLeadership`, and `taskDone` requeues only with `autoRequeue` (`:374-376`).                                                                                                                         |
| The task resolved                                               | The next round starts at once.                                                                                                                                       | The selector waits for `requeue()`.                                 | The same (`:374-376`).                                                                                                                                                                                                     |
| The task rejected                                               | The selector ends, after it gave the leadership up. `ended` and the dispose reject with the failure.                                                                 | The same.                                                           | `catch (Throwable e)` drops the failure (`:440-442`), and `autoRequeue` requeues.                                                                                                                                          |
| Giving the leadership up failed after the task resolved         | The selector ends with that failure. `ended` and the dispose reject with it.                                                                                         | The same.                                                           | Not read in Curator's source: its `mutex.release()` is in the `finally` of `doWork`.                                                                                                                                       |
| The acquire failed: no grant                                    | `process.emitWarning(error)`, then a wait of `backoff.duration(retries)` on `clock`, then the next round. `retries` counts the failed acquires since the last grant. | The selector ends. `ended` and the dispose reject with the failure. | With `autoRequeue`, a requeue at once: "autoRequeue should ignore connection loss or session expired and just keep trying" (`:469-484`). Without, the failure goes into the future of the executor, which no caller reads. |

The names are Curator's: `LeaderSelector`, `LeaderSelectorListener`, `takeLeadership`, `autoRequeue`, `requeue`, `interruptLeadership` and `hasLeadership`. `start` begins the first round at once, as Curator's `start()` calls `requeue()` (`:214-222`). Curator's `close()` is `[Symbol.asyncDispose]` here. The selector does not copy `getParticipants`, `getLeader`, `setId` and `getId`: `Key.isHeld` and the observer of `@zukhruf/election` answer the same questions.

Each divergence from Curator, and the rule that forces it:

- **A failure of the task ends the selector.** Curator drops it. This repository has no silent failure: the `no-silent-catch` rule of `@zukhruf/eslint` (`packages/eslint/src/errors/no-silent-catch.ts`) refuses a catch that drops an error. The end copies .NET's default `StopHost` and the crash of client-go (`HandleCrashWithContext`). The owner of the selector decides what comes next, for example `process.exit(1)`. A failure that comes again at each round would repeat with no end under a retry.
- **A failed acquire without `autoRequeue` ends the selector with its failure**, for the same rule, and so does a failed release of the leadership. A selector that a failure ended leads no more, so its `requeue()` throws, as after the dispose (Curator throws "close() has already been called"). Curator puts it in a future that no caller reads.
- **`autoRequeue` waits a back-off on a clock, and warns.** Curator requeues at once. client-go waits `RetryPeriod` with jitter, and Spring sleeps `busyWaitMillis`. A library that waits takes the clock as an input ([root ADR 0004](../../../../docs/adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md)); client-go keeps a `clock.Clock` field "to allow for less flaky testing" (`leaderelection.go:257-258`). The back-off is `Backoff` of `@zukhruf/async` ([its ADR 0011](../../../async/docs/adr/0011-a-back-off-gives-the-wait-before-a-retry-and-keeps-no-state.md)). The warning is `process.emitWarning`, as `src/mutex/mutex.ts:142` and `Term` of `@zukhruf/election` (`src/term.ts:133`) report a failure that they do not throw. A loss does not wait: the next acquire waits in the line of the key or of the claim.
- **A static `start`, and `autoRequeue` as an option of it.** Curator makes the selector with a constructor, takes `autoRequeue()` before `start()`, and refuses a second `start()` with "Cannot be started more than once" (`:215`). A made but not started selector is a state that the types can remove. Thus `start` makes and starts the selector in one call, and its options are fixed for its life. `BackgroundService.start` of `@zukhruf/async` has the same shape ([its ADR 0018](../../../async/docs/adr/0018-work-that-a-caller-owns-runs-as-a-background-service-that-a-dispose-stops-and-waits-for.md)).
- **The dispose waits for the end.** Curator's `close()` closes the executor and returns. Here the dispose aborts the selector and waits until the task ended and the leadership was given up, as .NET `StopAsync` waits for `ExecuteTask`. Thus a process can give the leadership up before it exits, and a standby takes over at once.
- **The listener gets the lease and a signal, not a client.** Curator gives `takeLeadership` the `CuratorFramework`, and tells a loss through `stateChanged` and a `CancelLeadershipException` that interrupts the thread. Here the loss aborts the signal of the lease ([ADR 0013](./0013-a-lost-lease-aborts-the-signal-of-the-lease.md)), and an `AbortSignal` is the interrupt of JavaScript. The listener has no `stateChanged`.
- **`hasLeadership` is a getter**, as TypeScript reads a state, and **`ended` is new**: Curator has no wait on the end. It is the `ExecuteTask` of .NET.
- **The source is a key that always acquires, or an election.** `Key<'always'>` only: a key whose acquire mode may give up returns `{ acquired: false }`, and a selector has no round without a grant. Curator's `mutex.acquire()` waits with no limit too.

## Considered Options

- **`holdForLife` over a `LeaseScope` in `@zukhruf/async`** (the earlier draft, async ADR 0019, withdrawn before a commit), with `LeaderElection.run` in `@zukhruf/election` (election ADR 0010, withdrawn too). The names and the shape were coined. The owner: "we should not be doing a divergence from the leading tools." A selector without `autoRequeue` is the lead-once call that `run` was, so the election needs no second API.
- **One selector for each backend, as Spring lays it out.** The listener contract lives in `@zukhruf/election`, and each backend package has its own `LeaderSelector` with the same name: Spring has `zookeeper.leader.LeaderInitiator` beside `LockRegistryLeaderInitiator`. The dependencies stay as today. The two classes then share the loop through a template step across packages, and TypeScript refuses a subclass whose static `start` has another signature. The owner chose `@zukhruf/mutex`.
- **Spring's `Candidate` with `onGranted` and `onRevoked`** (`Candidate.java:51`, `:60`). Two callbacks split one task: `onGranted` returns at once, the work runs somewhere else, and no one waits for its end. Spring's own ZooKeeper initiator turns `takeLeadership` into the two callbacks with a sleep of `Long.MAX_VALUE`. One async task gives the end, the failure and the release in one place.
- **Spring's `LockRegistryLeaderInitiator` loop**: `tryLock(heartBeatMillis)` in a poll, and a sleep of `busyWaitMillis` after a loss. The lock stores of this package wait in the line of a key, so a poll only adds load and delay. It also tries again after a failure of the task.
- **client-go's lead-once `Run`, with a process exit after a loss** (`RunOrDie`). datahub runs the work in the web process (#5408), so an exit at each loss restarts the web server.

## Consequences

- `LeaderSelector`, `LeaderSelectorListener` and `LeaderSelectorOptions` are new exports of `@zukhruf/mutex`. The package gets no new dependency: it depends on `@zukhruf/async` and `@zukhruf/election` today (`package.json:49-50`). The README section, the glossary entries and the index line come with the build.
- [ADR 0002](./0002-election-is-not-part-of-the-mutex.md) is superseded in part: the mutex now knows the election, through the selector. The election still does not import the mutex.
- The selector runs its rounds in a `BackgroundService` of `@zukhruf/async`, as Curator runs them on an executor (`CloseableExecutorService`). The dispose of the selector is the dispose of that service ([async ADR 0018](../../../async/docs/adr/0018-work-that-a-caller-owns-runs-as-a-background-service-that-a-dispose-stops-and-waits-for.md)).
- `@zukhruf/pool` gets a dependency on `@zukhruf/mutex`; today it depends on `@zukhruf/async` and `@zukhruf/election` (`packages/pool/package.json:44-45`). `pool-workers.ts` moves from its loop to the selector:

  ```ts
  // Before: src/pool-workers.ts:154-161, and #own resigns in its finally (:226-232).
  while (!stop.aborted) {
    const term = await this.#election.campaign({
      timeout: Infinity,
      signal: stop,
    });
    await this.#own(term!, stop);
  }

  // After:
  const leading = LeaderSelector.start(
    this.#election,
    { takeLeadership: (term, owning) => this.#own(term, owning) },
    { autoRequeue: { backoff, clock: this.#clock } },
  );
  ```

  The trap: today `#own` waits for its running jobs, resigns, and then closes the slots, because a close can be slow and a standby takes over before it ([pool ADR 0023](../../../pool/docs/adr/0023-ownership-moves-only-by-the-owners-own-act-or-its-end-and-a-standby-stays-cold.md)). The selector resigns only after `takeLeadership` returns. Thus `#own` must return after its running jobs, and give the close of the slots to the dispose stack of the pool, or the resign comes after the slow close. The pool needs `autoRequeue` to campaign again after a loss, so it changes one behaviour: a failed campaign, for example a `NetworkDirectoryError`, now warns and tries again after a back-off, where it ended the pool before. The start of the store and its close stay in the pool's own life, outside the selector.

- The election recipe "Run a job in only one process" moved to this package with the build, as [run-a-job-in-only-one-process.md](../recipes/run-a-job-in-only-one-process.md). Its program runs the job in a selector over `SqliteElection`, and its line "You do not need a mutex" is gone.
- datahub's writer (#5408) moves to one line, in the `AsyncDisposableStack` of its composition root:

  ```ts
  resources.use(
    LeaderSelector.start(
      mutex.key('warehouse-writer'),
      { takeLeadership: (lease, signal) => writeWarehouse({ lease, signal }) },
      { autoRequeue: { backoff, clock: globalThis } },
    ),
  );
  ```

- With `autoRequeue`, the selector tries again after each failed acquire, also after a fault that stays, because no lock store and no election tells a passing failure from a lasting one. Curator tries again only after `ConnectionLoss` and `SessionExpired`. #5438 gives each store a transient error class, so that the selector tries again only after those.
- `SqliteElection` never loses a living term, so the branch of a loss runs first for a key of datahub. The tests give the selector a key on a store that loses a lease.
