import type { Eviction } from './eviction.ts';

// Evicts no worker: each idle worker stays until the owner disposes the pool.
export class NoEviction implements Eviction {
  idle(): void {}
}
