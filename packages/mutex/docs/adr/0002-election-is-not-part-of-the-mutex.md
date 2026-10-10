# Leader election is not part of the mutex

Superseded on 2026-10-10 by [`@zukhruf/election`](../../../election/docs/adr/0001-leader-election-is-a-package-and-each-backend-is-a-subclass.md). The election is now a package of its own. The entry point `mutex/leader-election` is removed, and the socket lock store uses `SqliteElection`. The decision below stays true: the mutex and the other lock stores do not know the election.

Leader election solves one problem of one lock store: which process is the coordinator for the socket lock store. It is not a feature of a mutex. Thus leader election is a separate module with its own entry point (`mutex/leader-election`), and it does not import the mutex. The socket lock store uses leader election; the mutex and the other lock stores do not know that it exists.

## Consequences

You can use leader election alone, for example to run a job in one process only. A change to leader election cannot change how a mutex grants keys.
