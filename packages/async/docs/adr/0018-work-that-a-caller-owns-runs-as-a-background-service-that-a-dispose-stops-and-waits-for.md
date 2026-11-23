# Work that a caller owns runs as a background service that a dispose stops and waits for

Status: Accepted 2026-11-23 (#5408). Ezz chose "Accept as written" for the question whether this API, .NET's BackgroundService with one divergence (dispose and `ended` reject with the failure, where .NET's StopAsync suppresses it), is accepted. Built with LeaderSelector ([mutex ADR 0034](../../../mutex/docs/adr/0034-a-leader-selector-of-the-mutex-runs-a-task-each-time-it-leads-and-requeues-as-apache-curator-does.md)).

A caller starts work that runs until the caller stops it, for example a loop that watches a store. The caller must stop the work, wait for its end, and learn of a failure. Each place writes this by hand with an `AbortController`, a promise or a latch of the end, and a dispose that aborts and then waits. A search on 2026-11-23 found these places:

| Place                                                                                                               | What it keeps                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `@zukhruf/pool`, `src/pool-workers.ts:77`, `:87`, `:125-129`, `:148-167`, `:386-389`                                | `#disposed` (an `AbortController`), `#ended = Future.run(() => this.#live())`, a dispose that aborts and waits, a compare with the reason. |
| context-compiler, `apps/ambient/src/plugins/changes/index.ts:54-72`                                                 | `work()`: an `AbortController`, the promise of `followWarehouse`, `running.catch(failure.reject)`, a dispose that aborts and awaits.       |
| context-compiler, `apps/what-is-going-on/src/reading.ts:39-49`, `:27-33`                                            | `Watching`: an `AbortController` and a `Latch` of the end; `stop()` aborts and waits. A failure goes only to `console.error`.              |
| context-compiler, `apps/ambient/src/warehouse/follow-warehouse.ts:44-78`                                            | One `{ stop, done }` for each source; `reconcile` aborts and awaits `done`.                                                                |
| datahub, `apps/backend/src/services/warehouse/writer.ts` and `apps/backend/src/server.ts:31-49`, as #5408 describes | A forked writer that the web process supervises, and the running work in module globals (`const warehouseWriter`, `let writing`).          |

Two more places have the same parts but are not consumers of this decision: `void plugin.watch(watching.signal)` in context-compiler `apps/server/src/main.ts:440-443` aborts but never waits for the end, and the `Connecting` state of `connection-supervisor.ts:150-199` in `@zukhruf/mutex` and its recorded copy in `@zukhruf/single-flight` aborts a connect and waits for a latch inside a state machine. Thus the knowledge has at least 5 places: the Rule of Three moves it into one home.

No export of this package does the job. A `Future` holds the outcome of work, but it does not own a stop. A `Latch` carries no failure ([ADR 0002](./0002-a-latch-carries-a-value-never-a-failure.md)). A `WaitGroup` counts many works and has no stop and no failure ([ADR 0015](./0015-a-wait-group-counts-disposable-tokens-and-may-count-up-again-after-zero.md)). `Backoff` and `delay` wait, and own no work. Node.js 26 has no type for it: a search of the exports of each built-in module for `background`, `hosted`, `service` and `supervis` found nothing that owns work. `AsyncDisposableStack` composes disposables, but it does not start or stop work.

The leading systems:

| System                                                                                                                                                          | Start                                           | Stop                                                                                                            | A failure                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| .NET [`BackgroundService`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Hosting.Abstractions/src/BackgroundService.cs) (READ) | `StartAsync` runs `ExecuteAsync(stoppingToken)` | `StopAsync` cancels `stoppingToken`, then waits for `ExecuteTask` with `ConfigureAwaitOptions.SuppressThrowing` | `ExecuteTask` holds it. The host logs it, and with the default `BackgroundServiceExceptionBehavior.StopHost` it stops the host. The service never restarts. |
| Go [`errgroup`](https://pkg.go.dev/golang.org/x/sync/errgroup) with `context.WithCancel` (recalled, not read again)                                             | `g.Go(f)`                                       | `cancel()`, then `g.Wait()`                                                                                     | The first error cancels the context, and `Wait` returns it.                                                                                                 |
| Kotlin `Job` (recalled)                                                                                                                                         | `scope.launch { }`                              | `job.cancelAndJoin()`                                                                                           | It goes to the parent scope.                                                                                                                                |
| Effect `Effect.forkScoped` (recalled; #5408 research)                                                                                                           | a fiber in a scope                              | the close of the scope interrupts it                                                                            | It needs the Effect runtime.                                                                                                                                |

## Decision

This package exports `BackgroundService`. `BackgroundService.start(execute)` runs `execute(signal)` at once. A dispose aborts the signal and waits for the end of the work.

```ts
import { BackgroundService } from '@zukhruf/async';

await using resources = new AsyncDisposableStack();
const watching = resources.use(
  BackgroundService.start((signal) => watchStore({ signal })),
);
watching.ended.catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
```

```ts
class BackgroundService implements AsyncDisposable {
  static start(
    execute: (signal: AbortSignal) => Promise<void>,
  ): BackgroundService;
  get ended(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
```

- **The name is the one of .NET**, `BackgroundService`, and `execute` is its `ExecuteAsync`. #5408 sketched the name `Background`. Go has no type of its own for it.
- **A static `start`, not a subclass.** A .NET service is a base class, and the host calls `StartAsync` after the constructor. In TypeScript, a base constructor runs before the fields of the subclass, so the subclass needs a second call to start, and a service that was made but not started can be disposed. `start` makes the service and starts the work in one call, so that state cannot exist. A sync throw of `execute` is a failure of the work, as in `Future.run` ([ADR 0014](./0014-a-future-keeps-its-failure-as-data-and-only-a-wait-rejects.md)).
- **An end by the stop is no failure.** After the dispose aborts the signal, a rejection whose reason is `signal.reason` is a clean end, as .NET does not report an `OperationCanceledException` after `stoppingToken`. Each other rejection is a failure, also after the stop. The signal aborts with the default reason, a `DOMException` named `AbortError`. Thus each place that compares the reason by hand (`pool-workers.ts:163`, `follow-warehouse.ts:75`, `:100`) drops that compare.
- **`ended` is a wait.** It resolves when the work ends, and rejects with its failure. A `Future` holds the outcome, so a failure that nobody reads leaves no unhandled rejection. The name is the field name of `pool-workers.ts:87`. .NET names the task `ExecuteTask`.
- **A failure surfaces on the dispose too.** The dispose rejects with the same failure. `AsyncDisposableStack` then puts it in a `SuppressedError` beside the other failures of the stack. Here this package diverges from .NET, whose `StopAsync` suppresses the failure: there, the host already logged it from `ExecuteTask`. No host reads `ended` here, so a dispose that hid the failure could leave it silent. A second dispose waits for the first.
- **No restart.** A failure ends the work, as `StopHost`, the default of .NET. The owner decides what comes next, for example `process.exit(1)` so that the platform restarts the process. A loop that acquires again after a loss is `LeaderSelector` of `@zukhruf/mutex`, after Apache Curator, and it runs its rounds in a background service ([mutex ADR 0034](../../../mutex/docs/adr/0034-a-leader-selector-of-the-mutex-runs-a-task-each-time-it-leads-and-requeues-as-apache-curator-does.md)).
- **No time limit on the dispose.** Work that does not stop at the signal makes the dispose wait. The limit belongs to the owner's shutdown, for example the timeout of terminus or of `Shutdown` of `@zukhruf/shutdown`, as .NET gives the limit to `StopAsync` through the host's `ShutdownTimeout`.
- **An end before the stop** resolves `ended`. Then the dispose aborts a signal that nobody reads, and resolves.

## Considered Options

- **The name `Background`** (#5408's sketch). It is an adjective, and no leading system uses it.
- **The name `BackgroundTask`.** The glossary of this package avoids "task": the mutex runs a task while a caller holds a key (see [CONTEXT.md](../../CONTEXT.md)).
- **A base class with `protected execute(signal)`, as .NET.** It needs a start after the constructor, so a made but not started service exists. `pool-workers.ts` would extend it and lose its own job to the base class.
- **A dispose that suppresses the failure, as .NET.** The failure is then visible only to a caller that reads `ended`.
- **A restart policy in the service**, as the 30 s to 15 min back-off of datahub's `writer.ts` (#5408). The leading systems restart in the host or in a loop around the work. A loop that acquires again is `LeaderSelector` ([mutex ADR 0034](../../../mutex/docs/adr/0034-a-leader-selector-of-the-mutex-runs-a-task-each-time-it-leads-and-requeues-as-apache-curator-does.md)).
- **`effect` 4.x** (`Layer`, `Scope`, `forkScoped`, 66,627,362 downloads in the week to 2026-11-23). It needs its runtime in each consumer.
- **`effection`** (42,161 downloads). It is a structured concurrency runtime: each consumer writes generators.
- **`@tsnx/hosting`**, a port of the .NET `BackgroundService` (62 downloads in the week to 2026-11-23). This package has no dependency today, and a dependency for one small class is a cost with no gain: the port has no restart either (#5408 research). This reason is the author's judgment.
- **terminus, close-with-grace, lightship, http-terminator** (#5408 research). They only call callbacks at shutdown, and own no work.

## Consequences

- `BackgroundService` and the words background service and execute are new in this package (see [CONTEXT.md](../../CONTEXT.md)).
- It composes `Future` and `AbortController`. It adds no dependency to this package.
- `LeaderSelector` of `@zukhruf/mutex` is one of its users: the selector runs its rounds in a background service, as Curator runs them on an executor, and its dispose is the dispose of that service ([mutex ADR 0034](../../../mutex/docs/adr/0034-a-leader-selector-of-the-mutex-runs-a-task-each-time-it-leads-and-requeues-as-apache-curator-does.md)).
- After the build, the places of the table move onto it in their own steps (#5408): pool-workers first (through `LeaderSelector`), then the context-compiler places, and datahub's writer, whose module globals go into an `AsyncDisposableStack` of the composition root.
