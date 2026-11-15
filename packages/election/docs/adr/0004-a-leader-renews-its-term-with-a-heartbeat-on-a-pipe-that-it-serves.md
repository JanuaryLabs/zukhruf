# A leader renews its term with a heartbeat on a pipe that it serves

Status: Proposed 2026-11-15 for the owner's review (backlog #4371). Revised the same day to wait on pushes, not on a period ([ADR 0007](./0007-a-candidate-waits-on-pushes-from-the-leaders-pipe-not-on-a-period.md)). Not built.

The claim of `SqliteElection` is a kernel file lock. A hung leader keeps it: a leader that `SIGSTOP` stopped, or a leader whose event loop is blocked. Its term never ends, and no candidate can win (pool ticket 13; research 12-13 §G).

A hung process sends nothing. The kernel also keeps its socket open, so no close comes. Thus no push can tell a candidate about a hang. The research found no system that finds a hang without the help of the holder: the holder sends on a timer that it keeps, and the others time its silence (research 12-13 §E, §G):

| System                 | The holder sends                                         | The others give up on it after                     | Source                                         |
| ---------------------- | -------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------- |
| etcd lease             | a keepalive, every TTL / 3                               | the TTL with no answer                             | `client/v3/lease.go`, READ                     |
| etcd (Raft)            | a heartbeat to each follower, every `heartbeat-interval` | `election-timeout` with no heartbeat               | etcd docs v3.6, "Tuning", READ                 |
| ZooKeeper session      | pings on its connection                                  | the session timeout                                | research 12-13 §E, READ there                  |
| Kubernetes Lease       | a new `renewTime` in the record, every `RetryPeriod`     | `LeaseDuration` with no change, on their own clock | `tools/leaderelection/leaderelection.go`, READ |
| Consul session         | a renew of the session TTL                               | the TTL                                            | research 12-13 §E, READ there                  |
| systemd `WatchdogSec=` | `sd_notify("WATCHDOG=1")` on a socket                    | `WatchdogSec` with no notification                 | research 12-13 §G, READ there                  |

Thus a leader of `SqliteElection` renews its term with a heartbeat. It serves a pipe of `@zukhruf/pipes` for as long as its term lasts. Each candidate that waits for the claim holds a connection to that pipe ([ADR 0007](./0007-a-candidate-waits-on-pushes-from-the-leaders-pipe-not-on-a-period.md)), and each observer does too ([ADR 0009](./0009-a-process-that-does-not-campaign-observes-the-leader.md)). The leader sends a heartbeat on each connection when it accepts it, and then every `heartbeatInterval`. A heartbeat is one byte. A reader finds no meaning in its value.

The leader pushes the heartbeat. A reader only keeps a deadline: when a heartbeat comes, it sets the deadline to `leaseDuration` from now. etcd's client does the same with each keepalive answer: `ka.deadline = time.Now().Add(TTL)` (`lease.go`, READ). A reader that comes to the deadline treats the leader as hung ([ADR 0006](./0006-a-candidate-ends-a-leader-that-is-silent-past-the-lease-duration.md)).

## The names and the numbers

- `leaseDuration` is the longest silence that a reader accepts. The name and the default, 15000 ms, are Kubernetes' `LeaseDuration`: "the duration that non-leader candidates will wait to force acquire leadership" (`leaderelection.go`, READ; controller-runtime gives 15 s, research 12-13 §E).
- `heartbeatInterval` is the time between two heartbeats of the leader. The name is etcd's `heartbeat-interval`: "the frequency with which the leader will notify followers that it is still the leader" (etcd docs, READ). Kafka's consumer has the same pair, `heartbeat.interval.ms` and `session.timeout.ms` (RECALLED). Kubernetes' `RetryPeriod` is not the name, because nothing here tries again on a period.
- `heartbeatInterval` defaults to a third of `leaseDuration`, so 5000 ms with the default. etcd's client sends a keepalive every TTL / 3 (`lease.go`, READ). Kafka asks for at most a third of the session timeout (RECALLED). Thus a reader accepts two lost heartbeats, and the third silence ends the leader.

A reader counts the silence on its own clock, `clock.performance.now()`. client-go also counts from "the last observed" change on its own clock, and it uses the `LeaseDurationSeconds` of the record, not its own option (`isLeaseValid`, READ). It never compares a time of the leader with its own time. The clock is an input, as the clock of the campaign is today.

The heartbeat touches no file. Any `fs` call that opens the claim file drops the lock of the leader without a word (research 20a P4, 20h §1).

This backend takes no `renewDeadline`. In client-go, the holder gives up after `RenewDeadline` with no renew, and `LeaseDuration > RenewDeadline` lets a living holder stop before a candidate takes the lease (research 12-13 §E). That rule protects a claim that the store takes away by time. The kernel never takes the claim of `SqliteElection` from a living process, so no candidate can win before the old leader ends. A leader that gave up after a late heartbeat would end a term for no gain.

## Considered Options

- **A record file that the leader writes again on each period, as the `renewTime` of a Kubernetes Lease.** Each leader writes to the disk on each period, also when no reader looks. A reader must also poll the file to see the change. The pipe pushes the heartbeat to each reader that holds a connection, and it costs nothing when none does.
- **`utimes` on the claim file or on a file beside it.** `utimes` keeps the lock (research 20h §1), but it is a write to the disk on each period too, its time is the wall time, and a reader must poll it.
- **A `renewDeadline` for the leader, as client-go's.** Rejected for this backend: see above. A backend whose claim the store takes away by time keeps such a deadline in its `watch` (rule 3 of a backend).
- **A heartbeat on the pipe, pushed by the leader.** The same connection also carries the close of [ADR 0007](./0007-a-candidate-waits-on-pushes-from-the-leaders-pipe-not-on-a-period.md). This option was selected.

## Consequences

- `SqliteElectionOptions` gets `leaseDuration` and `heartbeatInterval`. `pollInterval` goes, with no alias ([ADR 0008](./0008-the-backend-owns-the-wait-between-two-tries-and-poll-leaves-the-campaign.md)).
- The constructor throws a `RangeError` unless `0 < heartbeatInterval < leaseDuration`.
- The heartbeat timer starts in `watch` and stops when the watch is disposed. It does not keep the process alive (`unref`). The pipe opens when the claim is won, and it closes in `close(claim)`, after the lock is free (ADR 0007).
- The signal of a term of `SqliteElection` still never aborts. A living leader never loses its term.
- To prove when built: a connect to the pipe of a stopped leader succeeds, because the kernel accepts it into the listen backlog [inference, not run]. A reader that connects after the hang depends on it: it gets no heartbeat, and its deadline comes.
