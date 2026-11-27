# A lost call follows the policy that its caller gives

Status: Accepted 2026-11-27 (backlog #4984).

Decision-makers: the zukhruf session mutex-91, which built step 1 of #4984, from the three tables it replaced. Paper v2 gave `'resend' | function`; the third policy is new here, and Ezz gave the go on the API as built on 2026-11-27.

Three places kept a table of the requests that wait for an answer: `RemoteLockClient` and `Queries` of the mutex, and `FlightClient` of the single flight (#2538, #2496). Each one keeps the ids, the settle functions, the delivery state and a hold that keeps the process alive while it waits. They differ in what happens to a request that went out on a connection that was lost:

- an acquire, a look and a run go again on the next connection;
- a try is one attempt: once the next connection opens, it is answered busy, and when no coordinator comes, it rejects with `CoordinatorUnavailableError` (`ipc-store.test.ts`, "with no coordinator left, a waiting acquire, a try in flight, and every later call reject");
- a call of the SQLite engines rejects at once with `ConnectionLostError`, because a `send` may have committed (paper v2, after pg-boss `db.js:129-146`).

## Decision

`PendingCalls.add(id, request, onLost)` takes one of three policies: `'resend'`, `{ atLoss }` or `{ atReconnect }`. The owner reports each loss with `interrupt()` and each new connection with `resume()`, so it sends its own messages first: the mutex sends its reassertions and its end-of-reasserts marker before the requests that wait (mutex ADR 0033). The table does not listen to the supervisor itself, because the order of two listeners is not a contract.

A call holds a token of a `RefCount` that the owner gives, so two tables on one connection (the mutex's requests and looks) unref it only when neither has a call.

## Considered Options

- **`'resend' | function`, with the function at the loss (paper v2).** The mutex's try would be answered busy at the loss, and a try in flight when no coordinator comes would no longer reject with `CoordinatorUnavailableError`. `ipc-store.test.ts` caught it.
- **The function at the next connection.** A call of the engines would wait for a restart that may take 30 s, where the paper asks for a rejection at once.
- **A table that listens to `connected` and `disconnected` itself.** Its sends would go before or after the owner's by the order of the listeners.

## Consequences

The mutex's try keeps its behavior. The `Client` passes `{ atLoss }` with `ConnectionLostError`. A delivery state `lost` holds the `atReconnect` function, so a lost call with no such function cannot exist.

## Confirmation

`src/call/pending-calls.test.ts` runs each policy over real worker threads that a connector starts again; each test was seen failing with its behavior broken in memory (`mutate.mjs`, 2026-11-27: P18, P19, P19r, P20 CAUGHT). The mutex's `ipc-store.test.ts` and `socket-store-reconnect.test.ts` pass on the switched client.
