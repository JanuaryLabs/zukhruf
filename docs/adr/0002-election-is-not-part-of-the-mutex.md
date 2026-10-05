# Leader election is not part of the mutex

Leader election solves one problem of one lock store: which process is the coordinator for the socket lock store. It is not a feature of a mutex. Thus leader election is a separate module with its own entry point (`mutex/leader-election`), and it does not import the mutex. The socket lock store uses leader election; the mutex and the other lock stores do not know that it exists.

## Consequences

You can use leader election alone, for example to run a job in one process only. A change to leader election cannot change how a mutex grants keys.
