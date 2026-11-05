import type { JsonPair } from '../json-pair.ts';
import type { Metric } from '../metric.ts';
import { Gate } from './gate.ts';

// A gate: 1 when the metric reaches the threshold, else 0.
export class AtLeast extends Gate {
  readonly #metric: Metric;
  readonly #threshold: number;

  constructor(metric: Metric, threshold: number) {
    super();
    this.#metric = metric;
    this.#threshold = threshold;
  }

  protected holds(pair: JsonPair): boolean {
    return this.#metric.of(pair) >= this.#threshold;
  }
}
