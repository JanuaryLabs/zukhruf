import { Climbing, type Window } from './climbing.ts';

// Finds how many workers pay by their throughput, as the .NET thread pool
// does (Hellerstein, Morrison and Eilebrecht, 2008): one more worker pays
// while it adds at least a tenth more jobs a second.
export class HillClimbing extends Climbing {
  protected measure({ jobs, span }: Window): number {
    return jobs / span;
  }

  protected pays(ratio: number): boolean {
    return ratio >= 1.1;
  }
}
