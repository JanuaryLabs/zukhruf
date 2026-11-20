# A hung owner is ended by the election, and its late acts are fenced

Status: Accepted 2026-11-20 (backlog #3527). The election part is built (backlog #4371). `PoolWorkers` campaigns with `timeout: Infinity` and the signal of its disposal (2026-11-16). It kills the worker of a hung helper at the kind's time limit, and settles nothing for a job that a touch did not find under its claim.

The claim of `SqliteElection` is a kernel file lock. A hung owner keeps it: a process that `SIGSTOP` stopped, a debugger, or a blocked event loop. No standby then wins, and every job of the computer waits (map ticket 13, research 02).

No system finds a hang without the help of the holder. The holder renews a lease on a timer that it keeps, and the others time its silence: Kubernetes Lease (15 s, 10 s, 2 s), etcd keepalive, ZooKeeper session, Consul TTL, systemd `WatchdogSec`. Every supervisor that finds a hang ends the process (systemd, the kubelet), and a cluster fences a silent peer in the same way (Pacemaker STONITH). With a kernel file lock, only the end of the holder's process frees the claim (research 12-13).

## Decision

From map ticket 13, resolved 2026-11-14 by the session from precedent. The concept belongs to the election, so the gap went there and was built before the pool (`@zukhruf/election` ADRs 0004 to 0009, backlog #4371):

- The leader of a `SqliteElection` serves a pipe of `@zukhruf/pipes` and sends a heartbeat on it. A candidate waits on that pipe. The close of the pipe tells it that the leader left, about 1 ms after the leader's process ends. A candidate that hears no heartbeat for `leaseDuration` (15 s, the default) kills the leader's process, while it holds that leader's pipe open, and then campaigns.
- **`PoolWorkers` campaigns on that election**, with `timeout: Infinity` and the signal of its disposal. It uses the defaults of the election. The pool adds no timer of its own for the owner.
- **A host that waits on a hung helper is not a hung owner.** Its event loop runs, so its heartbeat goes on, and the kind's time limit kills the worker ([ADR 0017](./0017-the-owner-asks-then-takes-as-many-jobs-as-it-has-free-workers.md)). Only a stopped process or a blocked event loop is a hung owner.
- **A late act of the old owner is fenced.** A `complete` or `fail` of a job that another owner took again affects 0 rows, by pg-boss's fence of the attempt. Research 20f fenced 361,800 of 361,800 settles right.
- **Across computers**, each computer elects its own owner, so the same rule holds on each computer. A job of a frozen owner on another computer comes back by its heartbeat ([ADR 0023](./0023-ownership-moves-only-by-the-owners-own-act-or-its-end-and-a-standby-stays-cold.md)).

## Consequences

- A hung owner holds the jobs of the computer for at most `leaseDuration`, and then the heartbeat of each running job gives it back ([ADR 0017](./0017-the-owner-asks-then-takes-as-many-jobs-as-it-has-free-workers.md)).
- A standby ends only an owner of its own user. The kernel refuses the kill for another user, and pools are per user ([ADR 0015](./0015-the-store-is-a-required-input-and-computer-store-gives-the-store-of-the-computer.md)).
- A host that runs as root can end an owner of any user. The election's README says to run the candidates of one group as one user.
