import type { JsonPair } from '../json-pair.ts';
import type { Metric } from '../metric.ts';

// A metric times its gates, multiplied left to right for each record. A gate
// on the means would give mean(a) × mean(b), so the gate is per record
// (ADR 0004).
export class Gated implements Metric {
  readonly #metric: Metric;
  readonly #gates: readonly Metric[];

  constructor(metric: Metric, ...gates: readonly Metric[]) {
    this.#metric = metric;
    this.#gates = gates;
  }

  of(pair: JsonPair): number {
    return this.#gates.reduce(
      (value, gate) => value * gate.of(pair),
      this.#metric.of(pair),
    );
  }
}
