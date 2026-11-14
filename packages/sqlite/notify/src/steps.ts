import { Latch } from '@zukhruf/async';

interface Step {
  readonly work: () => Promise<void>;
  readonly outcome: Latch<PromiseSettledResult<void>>;
}

/** Runs async work one after another, in the order of the calls. */
export class Steps {
  // The step at the head runs; the queue is empty when nothing runs.
  readonly #queue: Step[] = [];

  async run(work: () => Promise<void>): Promise<void> {
    const step: Step = { work, outcome: new Latch() };
    this.#queue.push(step);
    if (this.#queue.length === 1) void this.#drain();
    const outcome = await step.outcome.wait();
    if (outcome.status === 'rejected') throw outcome.reason;
  }

  async #drain(): Promise<void> {
    for (let step = this.#queue[0]; step; step = this.#queue[0]) {
      const [outcome] = await Promise.allSettled([Promise.try(step.work)]);
      this.#queue.shift();
      step.outcome.open(outcome);
    }
  }
}
