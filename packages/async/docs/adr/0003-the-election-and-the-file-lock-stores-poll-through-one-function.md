# The election and the file lock stores poll through one function

Two packages had the same loop. `LeaderElection` of `@zukhruf/election` calls `tryClaim` until it wins the claim or its deadline is in the past. `FileLockStore.poll` of `@zukhruf/mutex` calls an attempt until the attempt gives a lock, and it has no deadline. Each loop calls the attempt, and stops when the attempt gives a value. Then it waits a poll interval, and stops the wait when the signal aborts. The loops came in different commits (`5ae78e3` for the mutex, `a2713ea` for the election), and no record gives a reason to keep them apart. The single flight will need the same loop a third time, for its wait on the execution lock. That is the third place, so the Rule of Three of the [zukhruf ADR 0001](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md) moves the loop into one home.

The loop moves into `poll` in this package, because this package is in the base layer and both consumers already depend on it. `poll` keeps the shared part of the two loops:

1. Call the attempt. A value other than `undefined` resolves the poll with that value.
2. When a deadline is given and `performance.now()` is at the deadline or after it, resolve with `undefined`.
3. Wait `interval` milliseconds with `untilAborted(delay(interval, undefined, { signal }), signal)`. The signal of `delay` stops the timer. `untilAborted` rejects with the reason of the signal ([ADR 0001](./0001-a-wait-listens-for-the-abort-through-addabortlistener.md)).
4. Go to step 1.

An error from the attempt rejects the poll with the same error. The order of steps 1 and 2 is important: a deadline that is already in the past still gives one attempt. A campaign with a `timeout` of 0 tries the claim one time.

The deadline is a time from `performance.now()`, not a duration, because a campaign uses one deadline for all its attempts. Two overloads give the type of the result: with a deadline, `Promise<T | undefined>`; without a deadline, `Promise<T>`. Thus the mutex needs no non-null assertion.

Some parts stay with each consumer:

- The election opens its attempt before the poll and closes it after the poll. It also changes its `timeout` into a deadline.
- `FileLockStore` keeps `protected poll(attempt, signal)`. A subclass that a user writes calls it ([the recipe](../../../mutex/docs/recipes/write-your-own-lock-store.md)), and it gives the `pollInterval` option of the store to `poll`.

## Considered Options

- **Keep two copies.** The third place is known: the wait of the single flight on the execution lock. Two copies would become three.
- **A function for file locks only, in `@zukhruf/fs`.** This package would then need `@zukhruf/fs`. Also, two of the three attempts of the mutex are not file locks (`LockFileStore` and `TicketQueueFileStore`), and the claim of the election can be a row in a database.
- **A deadline as `AbortSignal.timeout`.** At the end of its time, the signal rejects the poll. The election must resolve with `undefined` after at least one attempt.
- **A base class that has the loop.** The election and the lock stores have no common base class. One base class would tie two unrelated hierarchies together for one loop.
- **`p-wait-for` from npm.** Its `timeout` rejects with a `TimeoutError`, and the election must resolve with `undefined`. It also adds a dependency that we must update.
- **A function in this package, with the shared part only.** This option was selected.

## Consequences

- A correction to the loop goes into one place. The election and the file lock stores get it together.
- `poll` has no parameter that no consumer uses. A new parameter waits for a consumer that needs it.
- The loops of the `ElectingConnector` in the mutex and in the single flight do not use `poll`. They have a different shape: they wait only after a lost campaign, and the wait for a hang-up has three exits and throws at its deadline. They are transport copies, and they wait for backlog item #2496.
- The single flight starts to use `poll` in a later step.
- The `ref` option came with its first consumer, as the second consequence says. The coordinator of the single flight watches the lock of a parked key with `poll`, and the coordinator must not keep its process alive (backlog item #2573). With `ref: false`, the wait between two attempts does not keep the process alive.
