# A package warning names its type, code and subject, and keeps the failure as its cause

Status: Accepted 2026-11-24 (backlog #5472). For the convention, the owner chose "Accept (Recommended)". For a shared helper, he chose "Inline now, file the helper (Recommended)": each site writes the call inline, and the helper waits for his go as backlog #5474.

A package of zukhruf emits a process warning when work that no caller waits for fails: a give-back, a background acquire, a removal of a lost claim. Today 12 of the 14 `process.emitWarning(` calls in `packages/*/src` pass the raw failure and nothing else. A `'warning'` listener then gets `name: 'Error'`, the code of the failure (or none) and the message of the failure. It cannot tell the warning from one of Node or of another package, and it does not know the key, the session or the job. datahub forwards process warnings to Better Stack (datahub 751fa362, its #5408 switch). A failed acquire of a `LeaderSelector` showed there as `[process] A warning` with only the store's message, `SQL Server 127.0.0.1:1/WarehouseLocal cannot be reached.`, and no selector and no key.

### What Node gives

- `process.emitWarning(warning[, options])` takes `type` ("the name to use for the _type_ of warning", default `'Warning'`), `code` ("a unique identifier for the warning instance"), `detail` ("additional text") and `ctor`. "If `warning` is passed as an `Error` object, the `options` argument is ignored." ([process.html#processemitwarningwarning-options](https://nodejs.org/api/process.html#processemitwarningwarning-options))
- The `'warning'` event gets an `Error` with `name`, `message` and `stack` ([process.html#event-warning](https://nodejs.org/api/process.html#event-warning)). Node's own names end in `Warning`: `DeprecationWarning`, which "must include a `'code'`", `ExperimentalWarning`, `MaxListenersExceededWarning`, `TimeoutOverflowWarning`, `UnsupportedWarning` ([process.html#nodejs-warning-names](https://nodejs.org/api/process.html#nodejs-warning-names)).
- For a string, Node makes the warning as `new Error(warning)`, then sets `warning.name = String(type || 'Warning')`, `warning.code` and `warning.detail` (`lib/internal/process/warning.js:187-199`, [v26.13.0](https://github.com/nodejs/node/blob/v26.13.0/lib/internal/process/warning.js#L187-L199)). The printer writes `[code] `, then `name: message`, then `detail` on a new line (`:108-119`).
- `--disable-warning=code-or-type` (stable since v26.7.0) stops the print of a warning by its `code` or its `type`, and the `'warning'` event still fires ([cli.html#--disable-warningcode-or-type](https://nodejs.org/api/cli.html#--disable-warningcode-or-type); `warning.js:98-99`).
- "The `error.message` property of errors raised by Node.js may be changed in any versions. Use `error.code` to identify an error instead." ([errors.html](https://nodejs.org/api/errors.html)). Node names its error codes (`ERR_INVALID_ARG_TYPE`), and numbers only its deprecations (`DEP0005`), which [deprecations.html](https://nodejs.org/api/deprecations.html) lists as a registry.

### What other libraries do

- undici 7.30.2 gives a code with a string: `process.emitWarning('EventSource is experimental, …', { code: 'UNDICI-ES' })` (`lib/web/eventsource/eventsource.js:119`), `{ code: 'UNDICI-FETCH-patch' }` (`lib/web/fetch/request.js:397`), and the type `'ExperimentalWarning'` for its experimental agents (`lib/mock/snapshot-agent.js:23`). For a failure it emits its own error class with a name and a code: `process.emitWarning(new RequestContentLengthMismatchError())` (`lib/dispatcher/client-h1.js:1220`), whose `name` is `'RequestContentLengthMismatchError'` and `code` is `'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH'` (`lib/core/errors.js:183-189`). That class needs `Symbol.for('undici.error.…')` in `Symbol.hasInstance`, because `instanceof` fails across two copies of the package.
- pg-boss 12.39.0 uses the type and a named code: `process.emitWarning(…, 'DeprecationWarning', 'PGBOSS_DEP_YUGABYTEDB')` (`dist/attorney.js:486`).
- The AWS SDK for JavaScript 3.980.1 puts its name in the message text only: ``process.emitWarning(`NodeVersionSupportWarning: The AWS SDK …`)`` (`@aws-sdk/core/dist-es/submodules/client/emitWarningIfUnsupportedVersion.js:14`). Its `name` is `'Warning'` and it has no code, so `--disable-warning` cannot select it. The SDK reads its own variable `AWS_SDK_JS_NODE_VERSION_SUPPORT_WARNING_DISABLED` instead (`:6`).
- zukhruf already has one typed warning: `{ type: 'DeprecationWarning', code: 'ZUKHRUF_ESLINT_REACT_CONFIG' }` (`packages/eslint/src/plugin.ts:59-62`).

### What a listener gets

A probe on Node v26.13.0 emits a failure of a store, `Error('SQL Server 127.0.0.1:1/WarehouseLocal cannot be reached.')` with `code: 'ESOCKET'`, in five ways. It records what a `'warning'` listener gets:

| Form                                                                    | `name`                  | `code`            | `detail`    | `message`     | `cause`         | stack starts at |
| ----------------------------------------------------------------------- | ----------------------- | ----------------- | ----------- | ------------- | --------------- | --------------- |
| A. The failure (today)                                                  | `Error`                 | `ESOCKET`         | none        | the store's   | none            | the store       |
| B. The failure with `{ type, code, detail }`                            | `Error`                 | `ESOCKET`         | none        | the store's   | none            | the store       |
| C. A string with `{ type, code, detail }`                               | `LeaderSelectorWarning` | `ZUKHRUF_MUTEX_…` | `key: jobs` | the package's | none            | the package     |
| D. `new Error(message, { cause })` with `name`, `code` and `detail` set | `LeaderSelectorWarning` | `ZUKHRUF_MUTEX_…` | `key: jobs` | the package's | the store error | the package     |
| E. The failure with its `name`, `code` and `detail` overwritten         | `LeaderSelectorWarning` | `ZUKHRUF_MUTEX_…` | `key: jobs` | the store's   | none            | the store       |

B shows that Node ignores the options of an `Error`. C loses the failure. E destroys the store's own `code` (`ESOCKET`) on an error that the package does not own. Only D keeps the failure whole, with its own code and stack, and gives the listener the package's type, code and subject. The stack of D starts where the package emitted it, so `--trace-warnings` shows the package frame, and `cause.stack` still shows the store. D is the object that `createWarningObject` makes, plus the standard `cause` of `new Error(message, { cause })`.

Node prints `cause` neither by default nor with `--trace-warnings`. A host with no listener reads only stderr, so the message ends with the message of the failure, as `fmt.Errorf("…: %w", err)` does in Go. The proposed form prints:

```
(node:53331) [ZUKHRUF_MUTEX_LEADER_SELECTOR_ACQUIRE_FAILED] LeaderSelectorWarning: The acquire failed, and the selector tries again: SQL Server 127.0.0.1:1/WarehouseLocal cannot be reached.
key: jobs
```

and the listener gets:

```
{"name":"LeaderSelectorWarning","code":"ZUKHRUF_MUTEX_LEADER_SELECTOR_ACQUIRE_FAILED","detail":"key: jobs","message":"The acquire failed, and the selector tries again: SQL Server 127.0.0.1:1/WarehouseLocal cannot be reached.","cause":"Error: SQL Server 127.0.0.1:1/WarehouseLocal cannot be reached. (ESOCKET)"}
```

`util.inspect` of the warning shows `[cause]`. `--disable-warning=ZUKHRUF_MUTEX_LEADER_SELECTOR_ACQUIRE_FAILED` and `--disable-warning=LeaderSelectorWarning` each stop the print, and the listener still gets the warning.

## Decision

Each process warning of a zukhruf package has the shape that Node gives its own warnings.

- **Type.** `name` is the concept of the package whose work failed, in PascalCase with the suffix `Warning`, as Node's `MaxListenersExceededWarning`: `LeaderSelectorWarning`, `MutexWarning`, `PoolWarning`. A deprecation keeps Node's `DeprecationWarning`.
- **Code.** `code` is `ZUKHRUF_<PROJECT>_<CONDITION>` in upper snake case: the Nx project name, then the condition, as Node's `ERR_…` names and the existing `ZUKHRUF_ESLINT_REACT_CONFIG`. A code is a name, not a number. Node numbers only deprecations, and keeps a registry page for them. A name tells a log reader the condition without a registry. A code never changes once released, and the message can.
- **Detail.** `detail` names the subject, one `<term>: <value>` line each, with the terms of the package's `CONTEXT.md`: `key: jobs`, `session: <id>`, `queue: <name>`.
- **Cause.** A failure is `new Error(message, { cause: failure })` with `name`, `code` and `detail` set. The package does not change the failure itself. `message` says what failed and what the package does next, then `: ` and the message of the failure (`String(failure)` for a value that is no `Error`). A condition with no failure, such as a deprecation, is a string with `{ type, code, detail }`.
- **Inline.** Each site writes the call itself:

  ```ts
  process.emitWarning(
    Object.assign(
      new Error(
        `The acquire failed, and the selector tries again: ${Error.isError(error) ? error.message : String(error)}`,
        { cause: error },
      ),
      {
        name: 'LeaderSelectorWarning',
        code: 'ZUKHRUF_MUTEX_LEADER_SELECTOR_ACQUIRE_FAILED',
        detail: `key: ${key.name}`,
      },
    ),
  );
  ```

  `cause` takes any value, so the guard `Error.isError(error) ? error : new Error(String(error), { cause: error })` of 11 sites goes away. pool keeps its one `warn` function, which then takes the message, the code and the detail from its 10 callers.

- **A lint rule.** `@zukhruf/eslint` gets a rule, `zukhruf/require-warning-code`, that reports a `process.emitWarning` call, or an `emitWarning` from `node:process`, when the warning has no code: a string with no `code` in its options, or an `Error` whose type has no `code` property. It also reports an `Error` with an options argument, which Node ignores (probe B). This is true for every repository, so the rule goes in the shared preset (memory "rules over agents").

### The sites

`git grep -nF 'emitWarning(' -- packages` on 57af5c73, outside tests: 14 calls in 9 packages. The 2 deprecations already conform.

| Site                                                               | What fails                                                                             | Subject                   | Type                       | Code                                                                                            | Detail                               |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------ |
| `packages/election/src/term.ts:133`                                | A lost term fails to stop watching or to free its claim (`#freeLost`)                  | the term                  | `TermWarning`              | `ZUKHRUF_ELECTION_TERM_FREE_FAILED`                                                             | `epoch: <epoch>`                     |
| `packages/eslint/src/plugin.ts:59`                                 | The config `zukhruf/react` is read; its name is now `zukhruf/shadcn` (#4990)           | the config                | `DeprecationWarning`       | `ZUKHRUF_ESLINT_REACT_CONFIG` (conforms)                                                        | none                                 |
| `packages/fs/src/create-exclusive.ts:25`                           | The removal of the draft fails after a create                                          | the draft                 | `CreateExclusiveWarning`   | `ZUKHRUF_FS_DRAFT_REMOVE_FAILED`                                                                | `draft: <path>`                      |
| `packages/mteb/src/dependencies/codecarbon.ts:1025`                | A call of the function of a `PeriodicScheduler` rejects (Python's `Timer`)             | the scheduler             | `PeriodicSchedulerWarning` | `ZUKHRUF_MTEB_PERIODIC_CALL_FAILED`                                                             | `interval: <s> s`                    |
| `packages/mutex/src/leader-selector/leader-selector.ts:142`        | An acquire of a round fails with `autoRequeue`, and the selector waits and tries again | the key or the election   | `LeaderSelectorWarning`    | `ZUKHRUF_MUTEX_LEADER_SELECTOR_ACQUIRE_FAILED`                                                  | `key: <name>` or `election: <class>` |
| `packages/mutex/src/lock-stores/docker/docker-engine-store.ts:426` | The removal of a lost claim's container fails (`Claim#removeLost`)                     | the key and the container | `DockerEngineStoreWarning` | `ZUKHRUF_MUTEX_DOCKER_CLAIM_REMOVE_FAILED`                                                      | `key: <key>`, `container: <id>`      |
| `packages/mutex/src/lock-stores/socket/lock-server.ts:160`         | The recovery check of a session fails, and the server ends its term (`#check`)         | the session               | `LockServerWarning`        | `ZUKHRUF_MUTEX_LOCK_SERVER_RECOVERY_CHECK_FAILED`                                               | `session: <id>`                      |
| `packages/mutex/src/mutex/mutex.ts:142`                            | The give-back of a lease that a cancelled acquire got fails (`giveBack`)               | the key                   | `MutexWarning`             | `ZUKHRUF_MUTEX_GIVE_BACK_FAILED`                                                                | `key: <key>`                         |
| `packages/pool/src/store.ts:130`                                   | `warn`, for 10 callers: a failure of the store that no caller waits for                | per caller, below         | `PoolWarning`              | per caller, below                                                                               | per caller, below                    |
| `packages/sqlite/queue/src/index.ts:630`                           | At stop, the fail of a worker's active jobs fails, and nobody listens for `'error'`    | the worker                | `SqliteJobQueueWarning`    | `ZUKHRUF_SQLITE_QUEUE_STOP_FAIL_UNHEARD`                                                        | `queue: <name>`, `worker: <id>`      |
| `packages/sqlite/queue/src/index.ts:632`                           | The same, and an `'error'` listener throws                                             | the worker                | `SqliteJobQueueWarning`    | `ZUKHRUF_SQLITE_QUEUE_ERROR_LISTENER_THREW`                                                     | `queue: <name>`, `worker: <id>`      |
| `packages/sqlite/queue/src/index.ts:1890`                          | `priority: false` or `orderByCreatedOn: false` is given to a fetch                     | the option                | `DeprecationWarning`       | `PGBOSS_DEP_FETCH_SORT` (conforms; pg-boss's own code, `dist/manager.js:2077`, kept for parity) | none                                 |
| `packages/sqlite/queue/src/timekeeper.ts:929`                      | A send-it job fails, and its `'error'` is unheard or a listener throws                 | the schedule              | `TimekeeperWarning`        | `ZUKHRUF_SQLITE_QUEUE_SEND_IT_UNREPORTED`                                                       | `schedule: <name>`, `key: <key>`     |
| `packages/ssh/src/control/shared-connection.ts:547`                | The election of a ref'd shared connection fails, and nobody waits for `ref()`          | the control socket        | `SharedConnectionWarning`  | `ZUKHRUF_SSH_SHARED_CONNECTION_ELECTION_FAILED`                                                 | `socket: <path>`                     |

The callers of pool's `warn`:

| Caller                                                                                            | Code                                   | Detail                       |
| ------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------- |
| `packages/pool/src/pool.ts:90`, `packages/pool/src/pool-workers.ts:111` (queue `'error'`)         | `ZUKHRUF_POOL_QUEUE_ERROR`             | `queue: <name>`              |
| `packages/pool/src/pool.ts:91`, `packages/pool/src/pool-workers.ts:112` (notifications `'error'`) | `ZUKHRUF_POOL_NOTIFICATIONS_ERROR`     | `queue: <name>`              |
| `packages/pool/src/store.ts:81` (`tell`, a notify fails)                                          | `ZUKHRUF_POOL_NOTIFY_FAILED`           | `channel: <channel>`         |
| `packages/pool/src/pool.ts:113` (a socket of an owner)                                            | `ZUKHRUF_POOL_OWNER_CONNECTION_ERROR`  | `queue: <name>`              |
| `packages/pool/src/pool-workers.ts:200` (a fetch fails)                                           | `ZUKHRUF_POOL_FETCH_FAILED`            | `queue: <name>`              |
| `packages/pool/src/pool-workers.ts:208` (a settle fails)                                          | `ZUKHRUF_POOL_SETTLE_FAILED`           | `queue: <name>`, `job: <id>` |
| `packages/pool/src/pool-workers.ts:379` (a touch fails)                                           | `ZUKHRUF_POOL_TOUCH_FAILED`            | `queue: <name>`, `job: <id>` |
| `packages/pool/src/pool-workers.ts:418` (the connection to a caller breaks)                       | `ZUKHRUF_POOL_CALLER_CONNECTION_ERROR` | `queue: <name>`              |

### The points that precedent settles

- **The message ends with the message of the failure.** Node prints `cause` neither by default nor with `--trace-warnings`, so a host that reads only stderr sees only `message`. Go's `fmt.Errorf("…: %w", err)` writes the wrapped error's text after `: ` in the same way.
- **A type names a concept, not a package.** Node names its types by the concept that warns, such as `MaxListenersExceededWarning`, and has no `NodeWarning` for all of them. One package can thus have several types: `@zukhruf/mutex` has `LeaderSelectorWarning`, `MutexWarning`, `DockerEngineStoreWarning` and `LockServerWarning`.
- **An election names its class.** `LeaderSelector` takes a key of the mutex or a `LeaderElection`. A key exposes its `name`. `LeaderElection` and `SqliteElection` expose no stable identity: `SqliteElection` keeps its directory and its claim file in private fields (`#directory`, `#claimPath`), and only `lastEpoch()` and `observe()` are public. So the detail of a selector over an election is `election: <the class of the election>`, such as `election: SqliteElection`. A public identity, as etcd's `Election.Key()`, is a change of `@zukhruf/election`, and backlog #5478 asks for it.

### What the build found

- The docker claim holds its container by ID, and removes it by ID. So its detail is `container: <id>`, not the name.
- The worker error of `SqliteJobQueue` has the fields `queue` and `worker` (pg-boss's spread copy of the error). So the detail of its two codes is `queue: <name>` and `worker: <id>`.
- pool's `warn` has 10 callers, not 11. It takes a `message` as well as the code and the detail, because each caller does something else next.
- The exit handler of the CO₂ tracker in `packages/mteb/src/dependencies/codecarbon.ts` emits its warning with `process.emit('warning', …)`, because the next tick of `emitWarning` never runs after `'exit'`. It is the 13th copy of the old expression in the ledger of `packages/mutex/docs/copied-code.md`, whose rule mirrors a fix in each copy. So it gets the shape too: `LockWarning`, `ZUKHRUF_MTEB_LOCK_RELEASE_FAILED`, `lockfile: <path>`. The lint rule does not see a `process.emit('warning', …)`.
- The lint rule is `zukhruf/require-warning-code`. On the code of 57af5c73 it reports the 12 sites of the table and neither deprecation. On the code of #5472 it reports nothing in zukhruf, and elt and context-compiler call `emitWarning` nowhere.

## Considered Options

- **The failure as it is (today).** The listener gets `name: 'Error'` and no subject (probe A). `--disable-warning` can select only the code of the failure, which other packages share.
- **The failure with options.** Node ignores the options of an `Error` (probe B, and the docs). The call reads as typed and is not.
- **A string with options.** This is the documented form, but it drops the failure, its code and its stack (probe C).
- **The failure with its fields overwritten.** The listener gets the type and the code, but the failure loses its own `name` and `code` (`ESOCKET` became the package's code in probe E). The package changes an error that it does not own, and the store or another listener can still hold it.
- **An error class for each type**, as undici's `RequestContentLengthMismatchError`. A host could use `instanceof`, but `instanceof` fails across two installed copies of a package, which undici works around with `Symbol.hasInstance`. Each package would export one more class. The code already identifies the warning, as Node says of `error.code`.
- **Numbered codes**, as Node's `DEP0005`. A number needs a registry page, which Node keeps because it has hundreds of deprecations. zukhruf has 14 sites.
- **One shared helper**, such as `warn({ type, code, detail, cause, message })` in a base-layer package. The count is 12 call sites in 7 packages, past strike 3. But the knowledge is Node's own API and one `Object.assign`, the lint rule keeps each copy in the shape, and the owner decides each extraction ("extraction waits for Ezz's go"). This ADR keeps the calls inline and leaves the helper to the owner, who chose to file it (backlog #5474).

## Consequences

- A host can sort, count and silence zukhruf's warnings by `name` and `code`, and a log line names the subject and the failure. datahub's Better Stack entry for the case above shows `LeaderSelectorWarning`, the code, the key and the store's message.
- Some sites do not hold their subject today. `LeaderSelector` keeps only a closure of its source, so it must keep the key's `name`. `giveBack` gets the key from `#acquire`. `#reportSendItError` gets the schedule from `#onSendIt`. pool's `warn` takes a message, a code and a detail from each caller.
- The tests that compare the arguments of a mocked `emitWarning` change: `packages/mutex/src/leader-selector/leader-selector.test.ts:304`, `packages/mutex/src/mutex/acquire-modes.test.ts:234` and `:270`, `packages/election/src/leader-election.test.ts:177`, `:207` and `:237`, and also `packages/ssh/src/client-ref.test.ts:969`, which read the failure itself. Backlog #5472 asks for one test per package through a real `'warning'` listener.
- A warning of a failure repeats at each failure, for example at each retry of a `LeaderSelector`. Node's advice to warn "only once per process" ([process.html#avoiding-duplicate-warnings](https://nodejs.org/api/process.html#avoiding-duplicate-warnings)) fits a deprecation, which both deprecation sites already follow, and not a failure that a host must see each time.
- A code is public API from its first release. A change of a code is a breaking change.
