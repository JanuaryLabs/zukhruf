# An eager pool starts a worker again after its warm-up fails

An eager startup starts workers before jobs need them, so that a job finds a warm worker. When `ready()` of a worker rejected, the pool killed and closed the worker and left its slot empty. No worker started there until a job needed the slot. That job then waited for a full warm-up. In context-compiler, a Vision worker warms up in 60 to 120 s, and Vision fails now and then under load (#2896). One failed warm-up thus made a job wait for a cold start, although the pool had time to warm a worker before it (#3675).

Now a failed warm-up is an early exit of its slot. In an eager pool, the slot counts one more early exit in a row and waits the back-off of ADR 0005: 1 s, doubled for each early exit in a row, up to 60 s. Then the pool starts a worker in the slot again. The rule holds for each failed start in an eager pool: for a worker that the startup starts, and for a worker that a job starts.

Mature pools show the same rule:

- Kubernetes kills a container whose startup probe fails. It then restarts the container under its restart policy, with the back-off of CrashLoopBackOff.
- HikariCP tries a failed create again: its `PoolEntryCreator.call()` waits 10 ms, doubled up to 5 s, while the pool still needs connections ([HikariPool.java](https://github.com/brettwooldridge/HikariCP/blob/dev/src/main/java/com/zaxxer/hikari/pool/HikariPool.java), branch `dev`). It runs that one loop when it fills its minimum and when a caller waits. Thus the cause of the start does not change what a failure does.
- Apache Commons Pool 3 gives the failure to its caller and does not try again.
- node-pool 3 does not try again for its minimum. While callers wait, it tries again at once: this is the loop that ADR 0005 stops.

The other rules stay:

- The job that waits for the failed warm-up fails, so each failure goes to the job that caused it (ADR 0005).
- A job does not wait for a back-off. Its worker starts now.
- `ready()` rejects when a worker that the startup starts with the pool fails. It tells how the startup went, not whether a later start succeeded.
- An `OnDemand` pool starts no worker before a job needs it, so it does not back off. The next job starts a new worker.
- A program that never warms up costs one start each 60 s at most, as an early exit in a loop does. The timer of the back-off keeps the process alive, as the timer of ADR 0005 does. Dispose the pool to stop it.

The pool waits the back-off with `delay` of `@zukhruf/async` on the clock that the caller gives (ADR 0008), as the eviction does. A job or the disposal aborts the wait. `p-retry` and `exponential-backoff` also compute an exponential back-off. But each one waits on the global `setTimeout`, so neither can run on the clock of the caller.
