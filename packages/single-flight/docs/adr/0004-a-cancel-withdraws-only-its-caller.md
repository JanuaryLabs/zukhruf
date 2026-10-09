# A cancel withdraws only its caller, and a flight runs to its end

A caller can cancel its wait with a signal. In the first design, a flight counted the callers of its process. When the last one cancelled, the flight left the map of its key, and a signal that the work got aborted ([ADR 0002](./0002-a-flight-that-all-callers-left-is-abandoned.md)). Now the callers of a flight can be in any process of the directory, and only the coordinator knows them. Thus a cancel withdraws only its own caller. A joiner that cancels leaves the flight, and the flight continues for the other callers. When the caller of the leader cancels, its call rejects with the reason of the signal, but the work continues and lands for the joiners. The work gets only the lease of the flight. A call that is withdrawn before its answer sends a cancel to the coordinator. If the coordinator had made it the leader, the work never started, so the flight is interrupted.

## Considered Options

- **The work stops when the last caller cancels ([ADR 0002](./0002-a-flight-that-all-callers-left-is-abandoned.md)).** The coordinator would count the callers of all processes, and it would tell the leader to stop. That is a new request for a case that a caller can see itself: a caller that does not want the work does not call.
- **A cancel withdraws only its caller.** Go's [`singleflight`](https://pkg.go.dev/golang.org/x/sync/singleflight) does this: the function gets no context, and a caller of `DoChan` stops only its own wait. Caches do this too: [nginx](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_cache_lock) continues a fetch that fills its cache after the client closed the connection. This option was selected.

## Consequences

- The work gets one signal, the signal of the lease. It aborts with `LeaseLostError` when the flight is no longer the leader's. No signal tells the work that its callers left.
- A flight continues after its last caller cancelled. The next call of the key joins it while it is in progress.
- A call whose signal aborted before the call rejects at once. It never leads and never joins.
