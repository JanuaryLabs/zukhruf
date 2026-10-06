# A caller cancels with a signal; an acquire mode gives up

A caller could not stop its wait. Each lock store stops a wait when a signal aborts, but the mutex took no signal from the caller. For example, an HTTP handler waited for a key after its client had left, and then reserved an item for nobody. Thus `Mutex.acquire` and `Key.run` take a `signal` for one call, and the mutex gives it to the acquire mode. When the signal aborts, the caller cancels: the call rejects with `signal.reason`, and the task does not run. The mutex makes sure of this for each acquire mode. A cancel is not the same as giving up. An acquire mode that gives up returns `{ acquired: false }`, which is a result. A cancel is an error, as for `fetch`.

## Considered Options

- **A signal as an option of skip if busy**, for example `Modes.skipIfBusy({ until: signal })`. A cancel would then be the result `{ acquired: false }`. But only an acquire mode that can give up could use it, and a caller that waits could not cancel.
- **Each acquire mode decides about a signal that aborted before the call.** Skip if busy makes one attempt first. It would get a free key for a caller that cancelled, and run the task. Wait would reject. One cancel would then have two results. Thus the mutex rejects before an acquire mode starts.
- **A signal on `tryAcquire`.** `tryAcquire` never waits for another holder, so it has no wait to stop. Only the first connect of a remote lock store can take time. Each lock store that you write would have to accept a signal that it does not need.

## Consequences

- `AcquireMode.acquire` gets a third parameter, `{ signal }`. An acquire mode gives the signal to each wait, so that a cancel stops the wait at once.
- An acquire mode that does not give the signal on cannot make a caller that cancelled wait. The mutex rejects the call at once. If that acquire mode gets a lease later, the mutex releases it.
- A cancel stops only the wait. When the caller holds the key, the task runs to its end. A task that must stop too gets the signal from its caller.
- A key does not keep a signal. A key lives longer than one call, and a signal is for one call.
