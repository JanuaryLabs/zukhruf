# A cancelled waiter of the memory store leaves the line

`MemoryStore` kept a line of latches for each key. Each caller waited for the latch of the caller before it, and a caller could not leave the middle of that line. Thus a caller that cancelled kept its place: when its turn came, it passed the key on to the next caller. A search on 2026-11-17 found 14 places in our repos that wrote such a line by hand (#4519), and `@zukhruf/async` now has `Lock`: a `Semaphore` of one permit that grants in order, and where a cancel leaves the line ([async ADR 0013](../../../async/docs/adr/0013-a-lock-is-a-semaphore-of-one-that-grants-in-order-and-a-cancel-leaves-the-line.md)). Ezz chose, in his words, "MemoryStore moves onto Lock" (#4529), with the change of the cancel.

## Decision

`MemoryStore` keeps a `Lock` for each key, and a count of the callers of the key: the holder and the callers that wait. A caller that cancels its wait leaves the line at once, and the caller behind it moves up. When the count is 0, the store removes the key from its map.

- **The order does not change.** The `Lock` grants the key to the callers in the order of their calls. A caller joins the line in the same turn as its call.
- **A release frees the key in the same turn.** When the holder releases and only cancelled callers were behind it, `isHeld`, `tryAcquire` and `holdsAnyKey` see the key free in that turn. Before, the key stayed held until the cancelled place passed it on, one turn later. `LockCoordinator` can read a release and a look in one turn (see `leaseFor`), so its answer to the look is now exact.
- **The fencing tokens and the leases do not change.** A grant mints its token from the token source of the store, and a failed mint frees the key (`leaseFor`).
- `InProcessTurns` puts each caller of `SqliteStore`, of the session lock stores and of `DockerEngineStore` in the line of a `MemoryStore`. A caller of these stores that cancels its wait for the turn in its process thus also leaves the line.

## Considered Options

- **Keep the line of latches.** A cancelled caller still costs one turn, and the store keeps code that `@zukhruf/async` now owns.
- **A `Semaphore` with one permit, with no `Lock`.** `Lock` is the name of the concept, and it has no count of permits to get wrong.

## Consequences

- A caller that cancels no longer keeps its place in the line of `MemoryStore`. `TicketQueueFileStore` still keeps the place of a caller that stopped its wait ([acquire modes](../concepts/acquire-modes.md)).
- The latches of `MemoryStore` that [ADR 0009](./0009-a-phase-is-a-state-object-a-latch-or-an-event.md) names are gone.
