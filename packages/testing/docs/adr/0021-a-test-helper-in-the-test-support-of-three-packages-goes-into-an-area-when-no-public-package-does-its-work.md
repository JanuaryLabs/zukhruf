# A test helper in the test support of three packages goes into an area when no public package does its work

[ADR 0016](./0016-a-test-helper-goes-into-an-area-when-three-repositories-have-its-knowledge-and-it-does-not-use-mock.md) keeps a helper that only this repository has out of the areas. Its example is the worker process of the mutex tests. On 2026-11-17 the mutex, the single flight and the election each had a copy of `worker-process.ts` and of `fact-timeout.ts` in `src/testing/`. Each test waited for a fact with `t.waitFor` and `factTimeout`, a limit of 10 s of its own. In backlog #4205, a wait of the mutex tests ended at `factTimeout` on CI before the work that it waited for: the limits of a test and of its waits no longer nested.

The maintainer ruled for #4205: "Delete factTimeout, waits on t.signal". Asked on 2026-11-17 which test-support pattern he does not want, he said:

> src/testing/ folders, I think we can make the code you put into src/testing as proper module. it seems to concern repositries. unless we find public package we can use that would remove this handrolled code we can build proper one

## Decision

1. A test helper in the test support (`src/testing/`) of three packages goes into an area of this package, also when only this repository has its knowledge. Count the places as the Rule of Three does. Condition 2 of ADR 0016 stays: a helper that uses the `mock` of `node:test` stays out of the areas.
2. Before the helper goes into an area, look for a public package that does its work. Probe the package, and record the results. A package that does the work replaces the helper.
3. The worker process is `startWorker` and `WorkerProcess` of the `process` area (`@zukhruf/testing/process`). `next(match, { signal })` resolves with a message of the worker, sent before or after the call. The three copies are deleted.
4. A wait is `waitFor(check, { signal })` of the `async` area (`@zukhruf/testing/async`), or `next` of a worker process. The test's signal, `t.signal`, is its limit, so the test's own timeout ends it. A wait has no number of its own. A wait for an event awaits the event; `waitFor` is for a fact that only a read shows. The three copies of `fact-timeout.ts` are deleted.

## Considered Options

- **The copies stay** (ADR 0016). A fix to the worker process goes into three files, and each test keeps a limit of its own.
- **execa replaces the worker process.** execa 9.6.1 is installed (for `packages/coprocess`), and 10.2.1 is the latest version. The probes of 2026-11-17 (backlog #4205) gave the same results for both versions:
  - `getOneMessage` misses a message that the child sent before the call.
  - `getOneMessage` ignores its signal.
  - A child that closes early gives no stderr to the wait.
  - With `cleanup`, a child that has its own work survives a parent that SIGKILL ends.
  - The handle has no `Symbol.asyncDispose`.

  Thus execa does not do the work.

- **An area that no public package replaces.** This option was selected.

## Consequences

- The mutex, the single flight and the election import `startWorker` and `waitFor`. Their ledgers (`docs/copied-code.md` and `docs/copied-from-mutex.md`) list no copy of `worker-process.ts` or `fact-timeout.ts`.
- `t.waitFor` of Node takes no signal, so a test that uses it keeps a limit of its own. A test of these packages uses `waitFor` of the `async` area.
- `zukhruf/no-own-wait-limit` of `@zukhruf/eslint` reports a wait in a test that sets a limit of its own: `t.waitFor`, `settleWithin` and `AbortSignal.timeout`. A test whose subject is the abort reads the reason of its signal, and the rule allows it.
- The other copies that ADR 0016 names (`recordDiskWrites`, `mountAs` and `LosableElection`) are not in `src/testing/`. This ADR does not change them.
