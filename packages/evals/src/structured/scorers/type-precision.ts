import { Ratio } from '../../aggregation/ratio.ts';
import type { Scorer } from '../../scorers/scorer.ts';
import type { Comparison } from '../comparison/comparison.ts';
import type { LeafOptions } from './leaf-matches.ts';

// The stated leaves whose type the schema allows at their path, by the rules
// of the draft of the schema, over the stated leaves. With nullIsMissing, a
// stated null is no value, so it is not counted. A record that the schema
// accepts gives 1, so the value grades a record that the schema refuses. It
// has no gate: evaluate.py shows it only for a record that agrees with its
// schema (evaluate.py:291-295, 302-309), which makes it equal to
// SchemaCompliance, and its caller composes that with Penalized (ADR 0008).
export class TypePrecision implements Scorer<Comparison> {
  readonly #nullIsMissing: boolean;

  constructor({ nullIsMissing = false }: LeafOptions = {}) {
    this.#nullIsMissing = nullIsMissing;
  }

  score(comparison: Comparison): Ratio {
    const { schema } = comparison;
    let allowed = 0;
    let stated = 0;
    for (const pair of comparison.leaves({
      nullIsMissing: this.#nullIsMissing,
    })) {
      if (pair.stated === undefined) continue;
      stated++;
      if (schema.types.allows(pair.stated.path, pair.stated.value)) allowed++;
    }
    return new Ratio(allowed, stated);
  }
}
