# A caller leads or joins in one request to an elected coordinator, which pushes the outcome

The first design had two classes. `SingleFlight` shared a flight in one process. `SharedFlight` shared it across processes: the holder of a key of the mutex was the leader, it wrote a flight record, and a joiner in another process read that record again and again until the record had an outcome ([ADR 0001](./0001-a-joiner-follows-its-flight-record-without-acquiring-the-key.md)). That design had three problems. A joiner made two contacts that were not one step: the lock, and then the records. Each gap between them needed its own fix. The records kept outcomes for a keep window, and a joiner that came later lost its outcome. A joiner learned the outcome only at its next read. Thus each process that uses a directory now takes part in one election, as in the socket lock store of `@zukhruf/mutex`. The winner is the coordinator. Each call sends one request to the coordinator. The coordinator answers in one step: the caller leads a new flight, or it joins the flight in progress. When the leader lands its flight, the coordinator pushes the outcome to each joiner. One class does this for all callers: in one process, in many processes, and in worker threads.

## Considered Options

- **Flight records and repeated reads ([ADR 0001](./0001-a-joiner-follows-its-flight-record-without-acquiring-the-key.md)).** The problems above made this option go.
- **A join request in the lock coordinators of `@zukhruf/mutex`.** A prototype added it there, and a joiner got the outcome in about 1 ms. But a join is not a feature of a mutex, and the mutex classes stay for locks only.
- **A mode for one process, and a mode across processes.** Go's [`singleflight`](https://pkg.go.dev/golang.org/x/sync/singleflight) shares a call in one process only. A second path for one process gives no new feature, and it is a second set of rules to keep correct.
- **One owner for each key, across processes.** [groupcache](https://github.com/golang/groupcache) gives each key an owner process, and the other processes ask the owner, so one load fills the cache for all of them. An elected coordinator does the same for each key of a directory, without a list of the processes. This option was selected.

## Consequences

- Each call is a round trip to the coordinator, also when the coordinator is in the same process. A test measured an outcome in about 1 ms.
- The value goes to the joiners as text. A codec turns the value into text and back, and the leader gets the decoded value too. Thus each caller gets the value in the same shape.
- A key has at most one flight in a directory. A call after a flight ended starts a new flight: a flight is not a cache.
- When the process of a leader stops, the coordinator tells each joiner that the flight is interrupted, and no joiner runs the work again.
- When the coordinator stops, the next coordinator starts with a grace window. The leaders reassert their flights and send their landings again, and the joiners rejoin their flights ([ADR 0005](./0005-a-joiner-rejoins-its-flight-by-its-token.md)).
- The directory must be on a local file system, because the election uses a SQLite lock.
