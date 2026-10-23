import type { QueueRow } from './queue-rows.ts';

// pg-boss's queue cache (node_modules/pg-boss/dist/manager.js:839-864):
// replaced whole at start and every queueCacheIntervalSeconds, filled by a
// lookup that misses, and evicted by createQueue, updateQueue and deleteQueue
// (2016, 2067, 2086). Lookups here still read the live row; what workers take
// from the cache are the monitor's counts as of the entry's last read.
export class QueueCache {
  #queues = new Map<string, QueueRow>();

  replace(queues: QueueRow[]): void {
    this.#queues = new Map(queues.map((queue) => [queue.name, queue]));
  }

  // getQueueCache: an entry already cached wins over the row just read.
  fill(queue: QueueRow): QueueRow {
    const cached = this.#queues.get(queue.name);
    if (cached) {
      return cached;
    }
    this.#queues.set(queue.name, queue);
    return queue;
  }

  peek(name: string): QueueRow | undefined {
    return this.#queues.get(name);
  }

  evict(name: string): void {
    this.#queues.delete(name);
  }
}
