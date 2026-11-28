# The pool learns that a worker ended from its exit

Superseded in part on 2026-11-28 (#6155) for the package of the worker: `Coprocess` is in `@zukhruf/process` ([process ADR 0007](../../../process/docs/adr/0007-json-lines-and-messages-are-views-of-a-started-process-and-only-a-node-process-has-messages.md)).

The first pool read a `dead` property of a worker before it lent the worker. A process can exit a moment after the read, and its job then fails. execa gives no such property: a subprocess is a promise that settles at its exit. Thus a worker gives `exited()`, and the pool listens to it. When a worker exits, its slot is lost at once. When the startup starts workers with the pool and the worker had no job, the pool starts a new worker at once. After an early exit, the pool waits first ([ADR 0005](./0005-an-eager-pool-backs-off-before-it-replaces-a-worker-that-exited-early.md)). Piscina replaces a worker thread on its `exit` event in the same way. `@zukhruf/coprocess` records the same decision for a process.

A slot keeps its phase as one value: empty, a worker that starts, a ready worker since a time, a worker that ended, or a back-off. A worker that starts is a latch with the outcome of its start, not a promise that can reject before somebody waits for it (`@zukhruf/async`, ADR 0002).
