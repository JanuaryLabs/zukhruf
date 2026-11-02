import { type CapacityOptions, capacity } from './capacity.ts';
import type { Sizing } from './sizing.ts';

// Runs as many workers as the computer affords when the pool is built: one
// per CPU, while each finds memoryPerWorker free.
export class Resources implements Sizing {
  readonly ceiling: number;
  readonly current: number;
  readonly kept: number;

  constructor(options: CapacityOptions) {
    this.ceiling = capacity(options);
    this.current = this.ceiling;
    this.kept = this.ceiling;
  }

  record(): void {}
}
