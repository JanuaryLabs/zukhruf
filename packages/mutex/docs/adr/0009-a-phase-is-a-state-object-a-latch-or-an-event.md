# A phase is a state object, a latch, or an event

Many objects go through phases. A connection is connecting, connected, or closed. A coordinator is in its grace window, or it grants keys. The code kept such phases in fields: `#closed = false`, `#inGrace`, `#current: ClientConnection | undefined`, and a promise that started as a placeholder value. Each reader of such a field must know which phase holds. A method that reads the field after an `await` can act on a phase that has ended. Defects came from these fields: for example, a waiter got a grant after its lock store closed (ADR 0007). Thus no class keeps a phase in a field. A phase is a state object: one object is the current state, and each state does its own work. A wait until something ends is a one-shot latch, which opens once and never closes again. A fact that happens at one moment is an event, and the object keeps nothing.

## Considered Options

- **One union field for each object**, for example `#status: 'idle' | 'connected' | 'closed'`. It removes the combinations of fields that have no meaning. But each reader still branches on the field, and the work of all phases stays in one class.
- **Keep `store.role` with a value for "neither yet"**, for example `'candidate'` or `'idle'`. The glossary calls each leader and each follower a candidate, so `'candidate'` would have two meanings. Any other value only gives `undefined` a new name. A process starts to lead, or starts to follow a leader, at one moment, so the store emits the `'role'` event then and keeps nothing.
- **A `store.role` getter that reads other state**, for example the lock servers of the store and the status of its connection. The store would read its connection, and it would still need a value for "neither yet".

## Consequences

- `store.role` is removed. A consumer listens to the `'role'` event, and keeps the last value if it needs the current role. A follower gets the event again after each failover.
- The connection supervisor, the coordinator, and each session of the coordinator use state objects. `MemoryStore` queues its callers on latches. A connection delivers its messages and its loss as events.
- Two lint rules in `zukhruf/base` refuse the common forms. `zukhruf/no-promise-field` refuses a promise in a field. `zukhruf/no-phase-flag` refuses a boolean field, or a field that can be `undefined`, when code outside the constructor sets it. Neither rule sees a phase in a union field. A review must find that form.
