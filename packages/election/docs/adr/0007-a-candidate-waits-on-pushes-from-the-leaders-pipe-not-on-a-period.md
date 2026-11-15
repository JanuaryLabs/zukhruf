# A candidate waits on pushes from the leader's pipe, not on a period

Status: Proposed 2026-11-15 for the owner's review (backlog #4371). Revised the same day after the owner's words: "all we do here is because of using "pull/poll" insted of push". Not built.

Today a candidate finds that the leader left only by its next try. It tries every `pollInterval`, 10 ms, so each candidate that waits makes 100 tries a second for the whole term. After `SIGKILL` of the leader, the next candidate leads in about 10 ms ([concepts](../concepts/leader-election.md#evidence)). A socket tells it sooner: each client of a Unix socket gets `end` 1.6 ms to 3.7 ms after a kill of the server, on macOS and on Linux (research 20a P1).

## What the leading systems do

- **etcd.** `concurrency.Election.Campaign` puts the candidate's key, and then calls `waitDeletes(ctx, client, e.keyPrefix, e.leaderRev-1)`: it waits on a watch for the deletion of each key that is older than its own (`client/v3/concurrency/election.go`, READ). It never tries again on a period.
- **ZooKeeper.** The leader election recipe: "Watch for changes on "ELECTION/guid-n_j", where j is the largest sequence number such that j < i" (recipes, r3.9.3, READ). The watch fires when that znode goes. No period.
- **Kubernetes client-go.** The candidate calls `tryAcquireOrRenew` in `wait.JitterUntil(…, le.config.RetryPeriod, JitterFactor, true)`, with `JitterFactor` 1.2 (`tools/leaderelection/leaderelection.go`, READ). It polls.

Kubernetes polls because a candidate has no connection to the holder. It talks only to the API server, and the holder renews by a write to the Lease object. A frozen holder writes nothing, so a watch of the object gives no event, and the candidate must time the silence on its own clock in any case. client-go thus reads the record every `RetryPeriod` and counts from the last change that it observed (`isLeaseValid`, READ). No close of the holder can reach it.

A candidate of `SqliteElection` has what Kubernetes lacks: the leader's own pipe, on the same kernel ([ADR 0004](./0004-a-leader-renews-its-term-with-a-heartbeat-on-a-pipe-that-it-serves.md)). The kernel closes it when the leader's process ends, so the close is a push, as the deletion of a key is in etcd and the deletion of a znode is in ZooKeeper. Thus this backend waits as etcd and ZooKeeper wait.

## The wait

A candidate tries the claim (EAFP). When the try does not win, it waits for the first of these events, and then it tries again:

| Event                                                            | Kind                       | What the candidate does                                                                                                                           |
| ---------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `end`, `close` or `error` on its connection to the leader's pipe | push                       | The leader left, and the seat is free. It drops the connection and tries at once.                                                                 |
| The deadline of the heartbeat: `leaseDuration` with no heartbeat | timer, after a push failed | It ends the leader ([ADR 0006](./0006-a-candidate-ends-a-leader-that-is-silent-past-the-lease-duration.md)), then waits for the close, and tries. |
| The end of the back-off after a failed connect                   | timer, capped              | It tries again: the claim first, then the record and the connect.                                                                                 |
| The abort of the campaign's signal, or the campaign's `timeout`  | the caller's               | An abort rejects with `signal.reason`. At the `timeout`, it tries one last time, and then it resolves `undefined`.                                |

Before it waits, the candidate reads the leader record ([ADR 0005](./0005-the-leader-record-names-the-process-and-the-pipe-of-a-term.md)) and connects to its `address` one time, as `PipeAddress#connect` does (pipes ADR 0006). It keeps the connection across the waits of one campaign, until the close.

- No record, `ENOENT` or `ECONNREFUSED` on the connect: no process serves the pipe of the record. A new leader holds the claim but has not written its record or listened yet, or a published leader leads. The candidate waits the back-off.
- `EACCES` on the connect: the folder of the pipe belongs to another user. The candidate waits the back-off, as after the `EPERM` of a kill (ADR 0006).
- Any other error: the campaign rejects with it. Only the codes above are expected (EAFP).

## The back-off

A timer stays only where no push can exist. Between the win of a claim and the write of its record, nothing serves a pipe that a candidate can connect to, so nothing can push. That time is one durable write of the epoch and one `listen` [inference: a few milliseconds, not measured]. A candidate in it waits a back-off, as a client waits before it connects again:

- The first wait is 25 ms. etcd's client waits `defaultBackoffWaitBetween = 25 * time.Millisecond` between two retries (`client/v3/options.go`, READ).
- Each next wait is 1.6 times the last, with a jitter of ±20 %. These are gRPC's `MULTIPLIER = 1.6` and `JITTER = 0.2` (`doc/connection-backoff.md`, READ).
- The wait is at most 1000 ms. gRPC's `MAX_BACKOFF` is 120 s, for a server across a network that can be down for minutes. A local leader starts in milliseconds, so this cap is lower. The value 1000 is chosen here, not taken from a leading system: it is the longest wait that a candidate under a published leader, which serves no pipe, accepts before it sees that leader's end.
- A connect that succeeds starts the back-off again at 25 ms.

## Many candidates wake at once

ZooKeeper's recipe lets each client watch only the znode just below its own, "to avoid the herd effect" (recipes, READ). Here, each candidate that waits connects to the one pipe of the leader, so its close wakes each of them, and each tries. A try is one non-blocking `tryLock`, and the candidates of one computer are few. Thus this design accepts the herd: it costs one `tryLock` for each waiting candidate at each change of leader. A chain of pipes would add a pipe for each candidate and a repair of the chain at each end.

## The order of the end of a term

`close(claim)` frees the lock first. Then it closes the server and destroys each connection to it, because a `PipeServer` keeps open connections open (pipes README). Thus a candidate that the close wakes finds the claim free. The watch is disposed before the release, so the heartbeats stop first, but the pipe stays open until the lock is free.

## Considered Options

- **Tries every 10 ms, and no push (today).** Each waiting candidate makes 100 tries a second for the whole term.
- **A push by the close, and tries on a period beside it (the first version of this paper).** Kubernetes' `RetryPeriod` of 2 s, as a pull for the times when no connection is open. Each of those times is a failed connect, and a back-off covers it. The period only adds wakes while a leader is healthy.
- **`fs.watch` of the claim file.** On macOS it drops the lock of the leader (research 20a P4).
- **A chain of watches, as ZooKeeper's recipe.** See above.
- **Push first: the close and the heartbeat on the pipe, a deadline for the silence, and a capped back-off for a failed connect.** This option was selected.

## Consequences

- A candidate under a healthy leader makes no try and no wake, except one heartbeat every `heartbeatInterval`.
- After the end of a leader, the next try comes 1.6 ms to 3.7 ms after the kill (research 20a P1), not up to 10 ms.
- A campaign with no `timeout` tries one time and opens no connection. A campaign with `timeout: Infinity` waits until it wins or its signal aborts. The campaign sets no timer for an infinite `timeout`.
- Research 20j found that a push by a kept connection is blind where no connection is open (arm D1, S3 and S4). Here a candidate always tries the claim before it waits, and each wait with no connection is a back-off. Thus no leader can leave unseen.
- To prove when built: the kernel frees the lock before a candidate that the `end` woke tries it [inference: one exit closes both descriptors]. When the try fails, the candidate reads the record again and waits on the new leader.
