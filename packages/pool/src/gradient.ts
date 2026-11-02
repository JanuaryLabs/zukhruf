import { Climbing, type Window } from './climbing.ts';

// Finds how many workers pay by the time a job takes, as Netflix's
// concurrency-limits Gradient does: one more worker pays while a job takes at
// most half again the time it took with two. Past that, the workers queue for
// something they share. Work changes, so a step with fewer runs two workers
// again, as Netflix's GradientLimit and Envoy measure their base time again
// at their least concurrency: the time with two is then as fresh as the step.
export class Gradient extends Climbing {
  // For each size: a job's time with that many workers, divided by its time
  // with two, as last measured.
  readonly #slowdown = new Map<number, number>();

  protected measure({ jobs, busy }: Window): number {
    return busy / jobs;
  }

  protected pays(ratio: number, larger: number, smaller: number): boolean {
    if (larger <= 2) return true;
    const slowdown =
      (smaller <= 2 ? 1 : (this.#slowdown.get(smaller) ?? 1)) * ratio;
    this.#slowdown.set(larger, slowdown);
    return slowdown <= 1.5;
  }

  protected override fewer(): number {
    return 2;
  }
}
