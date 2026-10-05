# Threads use a coordinator, not Web Locks

Worker threads of one process need a shared lock store. Node.js has `navigator.locks` for this, but it grants one exclusive lock to two worker threads at the same time. `ProcessQueue()` in `src/node_locks.cc` checks that a name is free in one critical section and records the new holder in a second one; another thread can grant in between. Thus the thread that starts the workers is the coordinator (`ThreadLockCoordinator`), and each worker asks it for keys through its message port (`ThreadStore`). One thread decides every grant, so two grants for one key cannot overlap.

## Considered Options

- **Web Locks (`WebLocksStore`).** We built it and removed it. With 2 worker threads, 17 of 30 runs had two holders at the same time; with the main thread and 3 workers, 18 of 30. Raw `navigator.locks`, with no adapter code, gave the same result in Node.js 26.7 and 26.10. JavaScript code cannot close a gap inside one C++ function.
- **A lock in a `SharedArrayBuffer` with `Atomics`.** The CPU makes the compare and the write one step, so it does not race. But each worker must get the buffer from the main thread, a stopped holder thread keeps its key forever, string keys must share a fixed number of slots, and waiters have no order.
- **Keep `WebLocksStore` with a warning.** Its main use, two or more worker threads, was not safe.

## Consequences

The thread that starts a worker must call `coordinator.adopt(worker)`. A request costs one message round trip (8.7 µs on average in a test). When the coordinator's thread is busy, for example with 50 ms of CPU work, waiters wait 50 ms. If the main thread does heavy CPU work, start the workers and the coordinator from a separate worker thread.
