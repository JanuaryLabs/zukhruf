import type { Sizing } from './sizing.ts';

// Runs exactly the given number of workers, as Kubernetes runs a fixed number
// of replicas.
export class Fixed implements Sizing {
  readonly ceiling: number;
  readonly current: number;
  readonly kept: number;

  constructor(workers: number) {
    this.ceiling = workers;
    this.current = workers;
    this.kept = workers;
  }

  record(): void {}
}
