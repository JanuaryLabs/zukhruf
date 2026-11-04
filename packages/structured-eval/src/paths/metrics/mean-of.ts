import { NeumaierSum } from '../../aggregation/neumaier-sum.ts';
import type { JsonPair } from '../json-pair.ts';
import type { Metric } from '../metric.ts';

// The mean of some metrics for one record, with CPython's sum, such as a
// category of a benchmark.
export class MeanOf implements Metric {
  readonly #metrics: readonly Metric[];

  constructor(...metrics: readonly Metric[]) {
    this.#metrics = metrics;
  }

  of(pair: JsonPair): number {
    const sum = new NeumaierSum();
    for (const metric of this.#metrics) sum.add(metric.of(pair));
    return sum.value / this.#metrics.length;
  }
}
