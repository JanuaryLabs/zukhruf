import type { JsonPair } from '../json-pair.ts';
import type { Metric } from '../metric.ts';

// A metric whose value is 0 or 1: 1 when the pair holds what the gate checks.
// Gated multiplies a metric by its gates for each record. A subclass says
// what it checks (Template Method).
export abstract class Gate implements Metric {
  protected abstract holds(pair: JsonPair): boolean;

  of(pair: JsonPair): number {
    return this.holds(pair) ? 1 : 0;
  }
}
