# A package warning is an instance of its own class, which the package exports

Status: Accepted 2026-11-24 (backlog #5474). The owner saw the sketch of a shared helper, pool's `warn` with a type parameter, and said: "I don't like the warning abstraction. instead of we should have own class that each place does like process.emitWarning(new class)". For the shape below, he chose "Build it".

[Root ADR 0010](./0010-a-package-warning-names-its-type-code-and-subject-and-keeps-the-failure-as-its-cause.md) gives each process warning of a zukhruf package a type, a code, a subject and a cause. Its "Inline" bullet made each site build the warning in place: `Object.assign(new Error(message, { cause }), { name, code, detail })`. That is 13 copies of one expression in 7 packages, plus pool's `warn` for its 10 callers. Backlog #5474 held the question of a shared helper.

- undici emits its own error class: `process.emitWarning(new RequestContentLengthMismatchError())` (undici 7.30.2, `lib/dispatcher/client-h1.js:1220`). The class sets its `name` and its `code` (`lib/core/errors.js:183-189`).
- Node's own warnings each have a name of their concept, such as `MaxListenersExceededWarning`, and no shared `NodeWarning` type (root ADR 0010).
- A class lets a host test `warning instanceof LeaderSelectorWarning`. With two installed copies of a package, `instanceof` fails across the copies. undici works around this with `Symbol.hasInstance`. A host that can have two copies compares `code`, which never changes once released.

## Decision

Each type of warning of root ADR 0010 is its own class.

- **One class for each type.** The class `extends Error` directly. No base class and no shared helper function. The class sets its own `name`, its `code` as a literal type, its `detail` from its subject, and the failure as its `cause`. Its message says what failed and what the package does next, then `: ` and the message of the failure (`String(failure)` for a value that is no `Error`).
- **The constructor takes the failure and the subject.** `new TermWarning(error, { election, epoch })`. A type with more than one condition, `PoolWarning` and `SqliteJobQueueWarning`, takes the code in its subject, and the code sets the message. The subject of each code of `PoolWarning` has only the fields of that code.
- **Each site emits an instance.** `process.emitWarning(new TermWarning(error, { election: this.#election, epoch: this.epoch }))`.
- **The package exports the class**, from the entry point that exports its concept, as undici exports its errors.
- **A deprecation stays a string** with `{ type, code }`, as Node and pg-boss write it: `packages/eslint/src/plugin.ts` and `packages/sqlite/queue/src/index.ts`.
- **The lint rule refuses the old form.** `zukhruf/require-warning-code` reports an `Object.assign(…)` as the warning of `emitWarning`, also when it sets a code. So an instance of a class is the one form of an `Error` warning that passes.

### The classes

| Class                      | File                                                                   | Exported from           | Code                                                               |
| -------------------------- | ---------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `TermWarning`              | `packages/election/src/term-warning.ts`                                | `@zukhruf/election`     | `ZUKHRUF_ELECTION_TERM_FREE_FAILED`                                |
| `CreateExclusiveWarning`   | `packages/fs/src/create-exclusive-warning.ts`                          | `@zukhruf/fs`           | `ZUKHRUF_FS_DRAFT_REMOVE_FAILED`                                   |
| `PeriodicSchedulerWarning` | `packages/mteb/src/dependencies/periodic-scheduler-warning.ts`         | `@zukhruf/mteb`         | `ZUKHRUF_MTEB_PERIODIC_CALL_FAILED`                                |
| `LockWarning`              | `packages/mteb/src/dependencies/lock-warning.ts`                       | `@zukhruf/mteb`         | `ZUKHRUF_MTEB_LOCK_RELEASE_FAILED`                                 |
| `LeaderSelectorWarning`    | `packages/election/src/leader-selector-warning.ts`                     | `@zukhruf/election`     | `ZUKHRUF_ELECTION_LEADER_SELECTOR_CAMPAIGN_FAILED`                 |
| `MutexWarning`             | `packages/mutex/src/mutex/mutex-warning.ts`                            | `@zukhruf/mutex`        | `ZUKHRUF_MUTEX_GIVE_BACK_FAILED`                                   |
| `DockerEngineStoreWarning` | `packages/mutex/src/lock-stores/docker/docker-engine-store-warning.ts` | `@zukhruf/mutex/docker` | `ZUKHRUF_MUTEX_DOCKER_CLAIM_REMOVE_FAILED`                         |
| `LockServerWarning`        | `packages/mutex/src/lock-stores/socket/lock-server-warning.ts`         | `@zukhruf/mutex/socket` | `ZUKHRUF_MUTEX_LOCK_SERVER_RECOVERY_CHECK_FAILED`                  |
| `PoolWarning`              | `packages/pool/src/pool-warning.ts`                                    | `@zukhruf/pool`         | the 8 codes of the pool, by its subject                            |
| `SqliteJobQueueWarning`    | `packages/sqlite/queue/src/sqlite-job-queue-warning.ts`                | `@zukhruf/sqlite-queue` | `ZUKHRUF_SQLITE_QUEUE_STOP_FAIL_UNHEARD`, `…_ERROR_LISTENER_THREW` |
| `TimekeeperWarning`        | `packages/sqlite/queue/src/timekeeper-warning.ts`                      | `@zukhruf/sqlite-queue` | `ZUKHRUF_SQLITE_QUEUE_SEND_IT_UNREPORTED`                          |
| `SharedConnectionWarning`  | `packages/ssh/src/control/shared-connection-warning.ts`                | `@zukhruf/ssh/config`   | `ZUKHRUF_SSH_SHARED_CONNECTION_ELECTION_FAILED`                    |

The exit handler of the CO₂ tracker emits its `LockWarning` with `process.emit('warning', …)`, because the next tick of `emitWarning` never runs after `'exit'` (root ADR 0010). It emits an instance of the class too.

## Considered Options

- **The Error typed in place (root ADR 0010, "Inline").** A host cannot use `instanceof`, and each site repeats the message, the code and the guard of the failure's message. The owner rejected it for a class at each site.
- **One shared helper**, such as `warn({ type, code, detail, cause, message })` in a base-layer package. The owner rejected it: "I don't like the warning abstraction".
- **A base class**, such as `ZukhrufWarning`, which each class extends. It is the same abstraction in another form, and Node has no shared base type for its own warnings.
- **`Symbol.hasInstance` across copies**, as undici does. It adds a registry of symbols for one case that `code` already covers.

## Consequences

- A host can test a warning with `instanceof` the exported class, or compare its `code`. The listener gets the same `name`, `code`, `detail`, `message` and `cause` as before, so the shape of root ADR 0010 does not change.
- Each package exports one more class for each of its types. A class is public API from its first release, as its code is.
- pool has no `warn` function. Each of its 10 places emits `new PoolWarning(error, { code, ... })`.
- The classes repeat one shape: `extends Error`, a code, a detail and the message of the failure after `: `. The owner chose a class at each site over a shared helper, so the ledger of `packages/mutex/docs/copied-code.md` records the copies, and a fix to the shape goes into each class.
- The lint rule does not see an `Object.assign(…)` that a variable holds before the call, or a `process.emit('warning', …)`.
