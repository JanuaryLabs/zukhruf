// When a pool may evict an idle worker. The pool calls idle when a worker
// becomes idle, and the eviction calls evict when the pool may close it. The
// pool aborts busy when a job takes the worker first, the worker leaves its
// slot, or the owner disposes the pool. A worker that becomes idle is a fact
// at one moment, so it is an event: the eviction gets no promise to handle.
export interface Eviction {
  idle(busy: AbortSignal, evict: () => void): void;
}
