# Leader election is not part of the mutex

Superseded in part on 2026-11-23 (#5408) for its consequence that the mutex does not know the election. `LeaderSelector` of this package runs a task each time a process leads, over a key of the mutex or over a `LeaderElection` of `@zukhruf/election`, as Apache Curator's `LeaderSelector` sits beside its mutex ([ADR 0034](./0034-a-leader-selector-of-the-mutex-runs-a-task-each-time-it-leads-and-requeues-as-apache-curator-does.md)). The lock stores still do not know the election, except the socket lock store, and the election still does not import the mutex.

Superseded on 2026-10-10 by [`@zukhruf/election`](../../../election/docs/adr/0001-leader-election-is-a-package-and-each-backend-is-a-subclass.md). The election is now a package of its own. The entry point `mutex/leader-election` is removed, and the socket lock store uses `SqliteElection`. The decision below stays true: the mutex and the other lock stores do not know the election.

Leader election solves one problem of one lock store: which process is the coordinator for the socket lock store. It is not a feature of a mutex. Thus leader election is a separate module with its own entry point (`mutex/leader-election`), and it does not import the mutex. The socket lock store uses leader election; the mutex and the other lock stores do not know that it exists.

## Consequences

You can use leader election alone, for example to run a job in one process only. A change to leader election cannot change how a mutex grants keys.
