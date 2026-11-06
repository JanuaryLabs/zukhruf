import type { JsonPair } from '../json-pair.ts';
import type { Scorer } from '../scorer.ts';

// A scorer whose value is 0 or 1: 1 when the pair holds what the gate checks.
// Gated multiplies a scorer by its gates for each record. A subclass says
// what it checks (Template Method).
export abstract class Gate implements Scorer {
  protected abstract holds(pair: JsonPair): boolean;

  score(pair: JsonPair): number {
    return this.holds(pair) ? 1 : 0;
  }
}
