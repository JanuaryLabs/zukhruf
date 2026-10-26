import { Climbing, type Window } from './climbing.ts';

// Finds how many workers pay by the time a job takes, as Netflix's
// concurrency-limits Gradient does: one more worker pays while a job takes at
// most half again the time it took with two. Past that, the workers queue for
// something they share.
export class Gradient extends Climbing {
  #slowdown = 1;

  protected measure({ jobs, busy }: Window): number {
    return busy / jobs;
  }

  protected pays(ratio: number): boolean {
    if (this.#slowdown * ratio > 1.5) return false;
    this.#slowdown *= ratio;
    return true;
  }
}
