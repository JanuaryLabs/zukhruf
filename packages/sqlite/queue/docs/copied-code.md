# Code copied in this package

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. While copies exist, a fix in one copy goes into each copy, and the commit names each file.

## Test helpers in two places

**`outcome` that adds the code of the error, with the result of the call.**

- Places: `src/parity/fail.test.ts` and `src/parity/ids.test.ts`.
- Same: the call gives its result, or the class, the message and the `code` of the error.

**`outcome` that adds a code of type string.**

- Places: `src/parity/schedule.test.ts` and `src/parity/send-escapes.test.ts`.
- Same: the call gives `resolved`, or the class, the message and the `code` of the error when the code is a string.

**`jobInEachState` that makes one job in each state through the queue's own calls.**

- Places: `src/parity/complete.test.ts` and `src/parity/touch.test.ts`.
- Same: a fetch, then a fail, a cancel or a complete, makes a created, retry, active, completed, cancelled and failed job, each at attempt 0.
- Differs: the queue in `touch.test.ts` has `heartbeatSeconds`, and its fetch checks the ids that it gives.

**`fetchJob` that fetches one job and requires it to be the job `n`.**

- Places: `src/parity/queue-stats.test.ts` and `src/parity/get-queues.test.ts`.
- Same: the code. `fetchJobs` of `src/parity/touch.test.ts` checks a batch of ids and gives their attempts.

## Same name, other knowledge

`src/testing/outcome.ts` gives `resolved`, or the class and the message of the error. These `outcome` functions compare a different result, so each stays in its test file:

- `src/parity/fence.test.ts` gives the result of the call.
- `src/parity/policies.test.ts` gives the result of the call, and the code of a driver error.
- `src/parity/queue-lifecycle.test.ts` gives `resolved`, and the code of a driver error.
- `src/parity/send-request.test.ts` gives the result of the call in a `resolved` field.
- `src/parity/transactional.test.ts` gives the fields of an `AssertionError`.

## Copied by `@zukhruf/sqlite-notify`

The thread form of `@zukhruf/sqlite-notify` copies parts of this package's thread form, strike 2 (backlog #6374). Mirror every fix in both copies and name both files in the commit. The ledger with what differs and why is [sqlite-notify's copied-from-sqlite-queue.md](../../notify/docs/copied-from-sqlite-queue.md).

- `src/thread/host-clock.ts` → sqlite-notify `src/thread/host-clock.ts`.
- `src/thread/engine-thread.ts` → sqlite-notify `src/thread/engine-thread.ts`: the host side of the clock and the thread's lifecycle.
- `backoff` of `src/thread/sqlite-job-queue-thread.ts` → sqlite-notify `src/thread/notifications-thread.ts`.
- `seen` and `startHost` of `src/thread/sqlite-job-queue-thread.test.ts` → sqlite-notify `src/thread/notifications-thread.test.ts`.
