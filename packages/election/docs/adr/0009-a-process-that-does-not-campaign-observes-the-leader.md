# A process that does not campaign observes the leader

Status: Proposed 2026-11-15 for the owner's review (backlog #4371). Not built.

The socket lock store of `@zukhruf/mutex` and the coordinator of `@zukhruf/single-flight` have followers. A follower reached the leader's server, so it does not campaign until that connection closes (`ElectingConnector`, `packages/mutex/src/lock-stores/socket/electing-connector.ts:40-56`, and its copy in `packages/single-flight/src/connection/electing-connector.ts`). A hung leader keeps the connection open and answers nothing. Thus each follower waits forever, and no candidate ends the leader. The owner put this in the scope of #4371 (2026-11-15: "part of this work").

The leading systems give a process that does not campaign a way to see the leader:

- etcd: `Election.Observe(ctx)` returns a channel of the leader's key. "The channel closes when the context is canceled or the underlying watcher is otherwise disrupted." It watches the leader's key with `client.Watch` (`client/v3/concurrency/election.go`, READ).
- client-go: `OnNewLeader` "is called when the client observes a leader that is not the previously observed leader" (`tools/leaderelection/leaderelection.go`, READ).

Thus `SqliteElection` gets `observe()`. It returns a `LeaderObserver`: a reader of the leader's pipe, as a waiting candidate is ([ADR 0004](./0004-a-leader-renews-its-term-with-a-heartbeat-on-a-pipe-that-it-serves.md)), that never tries the claim.

```ts
using observer = election.observe();
const reason = await observer.left; // 'closed' | 'ended' | 'absent'
```

- The observer reads the leader record ([ADR 0005](./0005-the-leader-record-names-the-process-and-the-pipe-of-a-term.md)) and connects to its `address` one time.
- `left` resolves `'absent'` when there is no record, or the connect gives `ENOENT`, `ECONNREFUSED` or `EACCES`. The observer waits no back-off: the host decides what to do next.
- `left` resolves `'closed'` on `end`, `close` or `error` of the connection: the leader left.
- `left` resolves `'ended'` when the observer came to the deadline of the heartbeat, sent the kill, and the close came ([ADR 0006](./0006-a-candidate-ends-a-leader-that-is-silent-past-the-lease-duration.md)). After `EPERM`, it sets no new deadline and waits only for the close.
- `left` rejects with any other error (EAFP).
- `[Symbol.dispose]()` destroys the connection and clears the deadline. After it, `left` does not settle.
- The connection and the deadline timer do not keep the process alive (`unref`), as a follower's socket of today does not.

One observer reads one term. etcd's `Observe` reports each new leader on one channel. A host that wants the next term calls `observe()` again. It knows when, because it reconnects to the next leader's server then.

`observe()` is a method of `SqliteElection`, not of `LeaderElection`. Only this backend has a pipe, a record and a kill. etcd and client-go have the observe in the election itself, so when a second backend can observe, the method moves to `LeaderElection`.

## What changes for `@zukhruf/mutex` and `@zukhruf/single-flight`

The two `ElectingConnector` copies change in the same way. A fix to one goes into the other, and the commit names both files (single-flight ADR 0006, backlog #2496).

1. **The option.** `ElectingConnectorOptions.pollInterval` goes, with no alias. `election` becomes `Pick<SqliteElection, 'campaign' | 'observe'>`.
2. **A follower observes.** `#follow` opens an observer before the greeting. When `left` settles during the greeting, the connector destroys the socket and goes on as after a hang-up. After a welcome, the observer lives until the socket closes. A follower does nothing with `left`: when the observer ends a hung leader, the kernel closes the follower's socket too, and the `ConnectionSupervisor` reconnects as after any death of a leader.
3. **One try, not a short campaign.** `connect` calls `campaign({ timeout: 0, signal })`: one try. Today it campaigns for `pollInterval`.
4. **The waits of 10 ms go.** In `connect` and in `#outlastHangUp`, `delay(pollInterval, …)` comes after a lost try, while the server of the new leader is not reachable yet. It becomes: wait for the first of `observer.left` and the next step of the back-off of [ADR 0007](./0007-a-candidate-waits-on-pushes-from-the-leaders-pipe-not-on-a-period.md) (25 ms, × 1.6, ± 20 %, at most 1000 ms), and then reach again. Thus a leader that hung before its server listened is ended too. The back-off is the one of `@zukhruf/async` ([ADR 0008](./0008-the-backend-owns-the-wait-between-two-tries-and-poll-leaves-the-campaign.md)).

Then the options of the two packages:

| Package         | Today                                                                                                          | By this design                                                                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mutex`         | `SocketStoreOptions.pollInterval`, default 10, passed to `socketElection` and to `ElectingConnector`           | `pollInterval` goes. `leaseDuration?` comes, passed to `socketElection`, which passes it to `SqliteElection`. The default is the election's.                                                                                  |
| `single-flight` | `POLL_INTERVAL = 10` in `src/single-flight.ts`, passed to `flightElection`, `ElectingConnector` and `KeyLocks` | `flightElection` and `ElectingConnector` take no poll interval. `SingleFlightOptions.leaseDuration?` comes, passed to `flightElection`. `KeyLocks` keeps `POLL_INTERVAL`: its claim is a lock for each key, not the election. |

- The test helper `LosableElection` drops `pollInterval: 10` in each of its three copies ([copied code](../copied-code.md)).
- The grace window of the mutex, 500 ms, must exceed the time that a holder takes to reconnect. With the back-off, the first five waits add up to about 395 ms. To prove when built: a holder reasserts its keys inside the grace window after a kill of the leader, and after the end of a hung leader.

## Considered Options

- **A follower campaigns while it follows.** Each follower would hold two connections to one leader, and its campaign would win a term that its host must serve at once, while it still follows the old server.
- **A follower times out each request.** A request of the mutex can wait as long as its caller allows, so no timeout tells a hung leader from a held lock.
- **The host keeps the leader's process id and kills it.** The record, the pipe and the rule "kill only while the pipe is open" (ADR 0006) are facts of the election. A copy of them in each host is a second home for one rule.
- **An observer of the leader, after etcd's `Observe`.** This option was selected.

## Consequences

- `SqliteElection` exports `observe()`, and the package exports the type `LeaderObserver`.
- A follower of the mutex or of the single flight ends a hung leader after `leaseDuration`. Then a candidate wins, and the followers reconnect to its server.
- The waits of the two connectors are pushes, except the back-off while a new leader starts its server.
