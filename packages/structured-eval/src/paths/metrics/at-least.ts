import type { JsonPair } from '../json-pair.ts';
import type { Metric } from '../metric.ts';

// A gate: 1 when the metric reaches the threshold, else 0.
export class AtLeast implements Metric {
  readonly #metric: Metric;
  readonly #threshold: number;

  constructor(metric: Metric, threshold: number) {
    this.#metric = metric;
    this.#threshold = threshold;
  }

  of(pair: JsonPair): number {
    return this.#metric.of(pair) >= this.#threshold ? 1 : 0;
  }
}
