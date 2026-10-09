# A fencing token on every lease

A holder can lose its key and not know it, for example when its process is frozen. Then two holders can write at the same time. Thus each lease has a fencing token, and a fenced resource refuses writes with an old token. Every lock store gives fencing tokens, so that you can change the lock store and keep the same code. A token source makes the tokens while the key is held, and you can give a lock store a different token source.

## Considered Options

- **UUIDv7 as the fencing token.** UUIDv7 is unique and approximately ordered by time. A fencing token must be strictly ordered. In a test, 50,160 of 100,000 UUIDv7 values from one thread were not in order, and 936 of 2,000 values from two threads were in the wrong order.
- **Fencing tokens only from the socket lock store.** Only that lock store has failovers. But then the lease is not the same for all lock stores, and you cannot change the lock store without a change to your code.

## Consequences

A task gets its lease: `mutex.acquire(key, async (lease) => …)`. A token source that keeps its count in memory starts again at 1 when the process starts again. Use a durable token source with a durable fenced resource.

2026-10-09: `FencingToken`, `TokenSource`, the four token sources, and `FencedLease` (the lease that a task gets) are now in `@zukhruf/fencing`. Import them from that package. The tokens and the `.fence` files did not change.
