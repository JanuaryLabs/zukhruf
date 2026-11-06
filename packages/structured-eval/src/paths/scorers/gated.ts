import type { JsonPair } from '../json-pair.ts';
import type { Scorer } from '../scorer.ts';
import type { Gate } from './gate.ts';

// A scorer times its gates, multiplied left to right for each record. A gate
// on the means would give mean(a) × mean(b), so the gate is per record
// (ADR 0004).
export class Gated implements Scorer {
  readonly #scorer: Scorer;
  readonly #gates: readonly Gate[];

  constructor(scorer: Scorer, ...gates: readonly Gate[]) {
    this.#scorer = scorer;
    this.#gates = gates;
  }

  score(pair: JsonPair): number {
    return this.#gates.reduce(
      (value, gate) => value * gate.score(pair),
      this.#scorer.score(pair),
    );
  }
}
