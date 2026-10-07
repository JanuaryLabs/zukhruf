# Acquire modes are strategies over two lock store operations

Callers need different reactions to a busy key: wait, give up at once, or give up after a time limit. An acquire mode is a strategy object that the mutex calls for each acquire. Each lock store gives only two operations: `acquire(key, { signal })` and `tryAcquire(key)`. A new acquire mode uses these two operations, so it needs no change in any lock store. A key can have a default acquire mode that one call overrides, because two callers of one key can need different reactions (a cron job skips, an admin waits).

## Considered Options

- **A mode that is fixed for each key.** All callers of a key would get the same reaction. The cron job and the admin button of one report could not share the key.
- **A mode for each call only.** This works, but each caller of a key with one kind of caller must repeat the mode.
- **The name `skipAfter(ms)`.** It can be read as "skip the first 500 ms". `skipIfBusy({ waitAtMost: 500 })` says what happens.
- **A withdrawal line in the ticket queue.** A waiter that gave up would append `{ withdrawn: id }`. But a rewrite of the queue can lose that line, as it can lose a ticket, and the waiter has left and cannot append it again. The ticket would then block the key while its process is alive. Instead, the ticket stays in line, and the lock store removes it when it reaches the front.

## Consequences

A custom `LockStore` must implement both operations. Since [ADR 0015](0015-a-holder-check-never-acquires-the-key.md), a lock store has a third operation, `isHeld(key)`, for a holder check. Acquire modes do not use it, so a new acquire mode still needs only the two operations. The result of a mode that may give up is `{ acquired: true, value } | { acquired: false }`, so TypeScript makes the caller check `acquired`.
