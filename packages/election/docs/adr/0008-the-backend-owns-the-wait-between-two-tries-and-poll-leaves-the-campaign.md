# The backend owns the wait between two tries, and poll leaves the campaign

Status: Proposed 2026-11-15 for the owner's review (backlog #4371). Rewritten the same day for a campaign that waits on events. It replaces "The campaign owns its early wake, and poll gets none", which was written for a campaign that polls. Built 2026-11-15.

The campaign waits between two tries with `poll` of `@zukhruf/async` (`src/leader-election.ts:102-107`). `poll` waits a fixed `interval`, and only its signal can end that wait early. An abort rejects the poll (`packages/async/src/poll.ts:38-49`). The first version of this paper kept `poll` and asked where an early wake belongs: in `poll`, or in the campaign.

[ADR 0007](./0007-a-candidate-waits-on-pushes-from-the-leaders-pipe-not-on-a-period.md) removes the period. A candidate waits on events: the close of the leader's pipe, the deadline of the heartbeat, the end of a back-off, and the abort. Thus no wait on a period is left to wake early, and the question of the early wake goes away. `poll` does not change.

The events are facts of the backend. The pipe, the record and the kill are facts of `SqliteElection`. A backend across hosts has other events: etcd waits on a watch of a key, ZooKeeper on a watch of a znode (ADR 0007). The deadline and the abort of a campaign are the same for each backend. Thus the backend waits for its events, and the base keeps the deadline and the abort, as etcd's `Campaign` keeps the context and calls `waitDeletes` for its store (`client/v3/concurrency/election.go`, READ).

## The step

A backend gets a seventh step:

```ts
/**
 * Resolves when a try of the claim can win: the holder left, was ended,
 * or the backend wants a new try. Settles when `signal` aborts.
 */
protected abstract waitForChange(
  claim: Claim,
  signal: AbortSignal,
): Promise<void>;
```

The campaign is then a loop with no period:

1. `open(signal)`.
2. `tryClaim(claim, signal)`. A win begins the term, as today.
3. At or after the deadline, the campaign closes the attempt and resolves `undefined`.
4. `waitForChange(claim, wait)`, where `wait` aborts when the campaign's signal aborts or the deadline comes. The base sets the deadline timer on its `clock`, and sets none for an infinite `timeout`.
5. After an abort of the campaign's signal, the campaign closes the attempt and rejects with `signal.reason`. Else it goes to step 2. Thus a deadline gives one last try, as `poll` does today.

A backend with no push polls in its own `waitForChange`, for example with `delay` of `@zukhruf/async`. Then the period is a fact of that backend, and the base has none. The connection of `SqliteElection` lives for one `waitForChange`: the wait opens it, and the close of the pipe or the abort of the wait destroys it. A wait on the connection ends only with one of those two, so a connection that outlived its wait would never be used again.

The constructor of `LeaderElection` takes only the clock: `super(clock)`. `pollInterval` goes, with no alias.

## Considered Options

- **Keep `poll`, and give it an early wake.** The leading tools put an early wake in the consumer, not in the poll: Go waits on a ticker and a channel with `select`, and .NET on a delay and a token with `Task.WhenAny` (RECALLED). It also keeps a period, which ADR 0007 removes.
- **Keep `poll`, and add `notify` to `open(signal, notify)` (the first version).** It keeps a period beside the push. The period adds wakes while a leader is healthy.
- **The base waits on events that a backend emits.** The base would need a type for each kind of event, but only the backend gives them meaning. The deadline of the heartbeat also starts a kill, which is a fact of one backend.
- **A backend step that waits, and a base that keeps the deadline and the abort.** This option was selected.

## Consequences

- The campaign no longer calls `poll`. The other callers of `poll` do not change. The port of pg-boss's `notify()` in `@zukhruf/sqlite-queue` gets no copy, so the ledger of the first version is gone ([copied code](../copied-code.md)).
- A backend implements seven steps. The rules of a backend get one more: `waitForChange` settles when its signal aborts, and it never ends the attempt itself.
- The capped back-off of ADR 0007 has three places by this design: the wait of `SqliteElection`, the `ElectingConnector` of `@zukhruf/mutex`, and its copy in `@zukhruf/single-flight` ([ADR 0009](./0009-a-process-that-does-not-campaign-observes-the-leader.md)). The Rule of Three counts places, so it is strike 3. The back-off moves to `@zukhruf/async`, and the three places use it. Its API goes on paper in that package first, from gRPC's connection backoff and etcd's client retry, before this design is built.
