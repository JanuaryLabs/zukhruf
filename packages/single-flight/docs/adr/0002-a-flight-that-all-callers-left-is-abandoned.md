# A flight that all callers left is abandoned

> Superseded by [ADR 0004](./0004-a-cancel-withdraws-only-its-caller.md): a cancel now withdraws only its caller, and no flight is abandoned.

A caller can cancel its wait with a signal. The cancel of one caller must not stop the flight for the other callers, so no caller's signal reaches the work. But when all callers of a flight cancel, nobody waits for its outcome. Before this decision, the flight then continued for nobody. In a `SharedFlight`, a process that joins reads the flight record until the flight in the other process ends. When it finds no flight to follow, it tries the key, and it can run the work that all its callers cancelled. Thus each flight counts the callers that wait for it. When the last caller cancels, the flight is **abandoned**, in one synchronous step: the flight leaves the map of its key, and a signal that the work got aborts. The next call of the key starts a new flight. The work stops only when it reads the signal. In a `SharedFlight`, a process that joins stops to read the flight record, and it never tries the key for callers that left. A flight that a process leads continues to its end, because joiners in other processes, which this process cannot count, can wait for its outcome.

## Considered Options

- **The flight continues for nobody.** Go's `golang.org/x/sync/singleflight` does this: its function gets no context, and a caller of `DoChan` only stops its own wait. A process that joins then reads the flight records until the other flight ends, and it can start a flight that nobody wants.
- **The flight is abandoned when the last caller leaves.** The tools that only give the outcome to the callers do this. RxJS `share()` unsubscribes from the source when the count of subscribers is zero, and it resets, so the next subscriber starts again. Apollo Client removes the request in progress and aborts its HTTP request. In .NET `HybridCache`, the cancellation token of the factory is cancelled when all callers cancelled. The Go resolver in `net` forgets the lookup and cancels it when its only caller gives up. This option was selected.
- **The flight is abandoned, but it stays in the map until the work ends.** A caller that comes after the last caller left then joins a flight that is about to stop. Go issue 22724 shows this defect: a new lookup joined a lookup that a cancelled caller had stopped, and it failed with "operation was canceled". Thus the flight leaves the map in the same step as the abort.
- **The flight that a process leads is abandoned too.** Caches do not do this: nginx continues a fetch that fills its cache after the client closed the connection, and Varnish continues its fetch for the waiting list. A `SharedFlight` writes its outcome into the records like a cache, and joiners in other processes read it. Thus a flight that a process leads continues.

## Consequences

- The work of a `SingleFlight` gets a signal: `run(key, (abandoned) => …)`. Work that does not read it runs to its end. The next call can then start a second flight of the key while the abandoned work still runs.
- A `SharedFlight` never takes the key when no caller in its process waits. The mutex gets the signal of the flight, so a cancel that arrives while the process reads the records still stops the attempt.
- The work of a `SharedFlight` gets only the lease, and it does not get the signal of the flight.
