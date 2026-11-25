# Every async port takes an optional abort signal, and a composite rejects at once when it aborts

Status: Accepted 2026-11-25 (backlog #5587, #5588; paper #5638).

Decision-makers: Ezz, who approved the paper of #5638 on 2026-11-25 and answered its open question on the name: "the abort option is renamed abortSignal -> signal, as every other zukhruf package". The leader tables of the paper decided the rest.

[ADR 0006](./0006-a-retriever-gives-10-passages-when-the-caller-gives-no-topk.md) promises that `abortSignal` stops the call. But `PassageStore`, `PostgresSession`, `SqlServerSession` and `ContextWindow`'s store calls took no signal, and the Postgres keyword retriever checked it only before its query: aborted at 50 ms, it resolved after 302 ms (#5587). A child of `FusionRetriever` that ignored its signal kept the fused call pending after the caller aborted (#5588). Among the leaders with a cancellation token in each call, five of six make it optional and one requires it: .NET `CancellationToken = default`, Semantic Kernel, the AI SDK `abortSignal?`, LangChain.js `signal?`, and the DOM and Node `signal`, against Go's `ctx`. Four of the five that have it put it on every async call of their ports. The APIs that take an `AbortSignal` (DOM §3, `fetch`, Node, LangChain.js `raceWithSignal`, `@zukhruf/async` `untilAborted`) reject at once with the reason (paper #5638, Q8, Q9).

Supersedes in part:

- [ADR 0006](./0006-a-retriever-gives-10-passages-when-the-caller-gives-no-topk.md), for the name and the place of the signal. It was `abortSignal` on `RetrieveOptions` only; it is `signal` on every async port.

## Decision

- `signal?: AbortSignal` is on every async call of every port: `Retriever.retrieve`, `BatchRetriever.retrieveMany`, `Postprocessor.postprocess`, `PassageStore.get` and `neighbours`, `PostgresSession.query` and `SqlServerSession.query`. The name is the majority's (DOM, `fetch`, Node, LangChain.js) and that of every other zukhruf package; only the AI SDK says `abortSignal`.
- An implementation passes the signal to every async call it makes. An engine retriever passes it to its session, and `ContextWindow` passes it to its store. SQLite checks it before and after its synchronous statement.
- A composite (`FusionRetriever`, `MultiQueryRetriever`, `PostprocessingRetriever`, `HydeRetriever`) rejects with `signal.reason` as soon as the signal aborts, whatever its children do (`untilAborted`). An abort is never a failure.
- The signal stays optional. A host that requires one, as Meddit ADR 0009 does, enforces it at its own call sites.

## Considered Options

- **A required signal, as Go and Meddit ADR 0009.** It lost, 5 to 1, among the leaders. TypeScript cannot narrow an optional parameter in an implementation, so it would also make every host pass one.
- **Wait for the children, as `errgroup.Wait` and Python's `TaskGroup` do.** It lost: in JavaScript a child that ignores its signal never settles, and the APIs that take an `AbortSignal` reject at once.
- **Keep `abortSignal`, ADR 0006's name after the AI SDK.** It lost: Ezz chose `signal`, the majority's name and the name of every other zukhruf package.

## Consequences

- A host's Postgres session cancels with `pg_cancel_backend` or `untilAborted`, and a host's SQL Server session with `request.cancel()`.
- A child that ignores its signal keeps running after the composite rejected. That is the child's defect; JavaScript cannot stop a promise.

## Confirmation

`probes/run-signal.out` of paper #5638 (52 ms with a session that cancels, 314 ms without a signal) and `probes/run-fanout.out` (51 ms with a child that never settles).

Shipped (#5639): `signal` on every async port, with no `abortSignal` alias; `type-tests/published-types.ts` proves against `dist` that the old name no longer compiles on `retrieve`, `postprocess`, `get`, `neighbours` and a host session. Each engine retriever and store passes the signal to its session, `ContextWindow` to its store, and the embedding retrievers, `Rerank`, `MaximalMarginalRelevance`, `HydeRetriever` and `MultiQueryRetriever` map it onto the AI SDK's `abortSignal` at their model calls. `FusionRetriever` and `MultiQueryRetriever` reject their fan-out at once through `untilAborted`, and `PostprocessingRetriever`, `HydeRetriever` and the model call of `MultiQueryRetriever` do the same. Every built-in postprocessor rejects an aborted signal before its work, and `PostprocessingRetriever` checks the signal before each postprocessor, so none starts after the call rejected. `HydeRetriever` checks it before its model call, since the AI SDK's `generateText` (ai 7.0.179) calls the model with an aborted signal. SQLite's stores and retrievers check the signal before their synchronous statement: no abort can land while it runs, so a check after it would see nothing new; the embedding retriever also checks after its model call. The Postgres keyword test runs a host session that cancels with `pg_cancel_backend` against a real server: the search waits on a lock, the abort cancels it on the server (SQLSTATE 57014), and the call rejects with the signal's reason. Recording sessions prove that each engine retriever and store passes the call's signal, on Postgres and on SQL Server; locally the SQL Server tests skip, because the engine runs aarch64 and emulates SQL Server's linux/amd64, and CI runs them. A SQL Server session that cancels with `request.cancel()` has no test of its own here.
