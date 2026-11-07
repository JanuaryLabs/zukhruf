import { Ratio } from '../aggregation/ratio.ts';
import type { Penalty } from './penalty.ts';
import type { Scorer } from './scorer.ts';

// A scorer whose part is multiplied by the factor of each penalty, in the
// order of the penalties, for each record; the whole stays (Decorator). So a
// record that fails a gate keeps its expected values in the denominator of
// recall. A penalty on the means would give mean(a) × mean(b), so the
// penalty is per record (ADR 0004). When every factor is 1, the ratio of the
// scorer stays as it is, so an F-measure keeps the value of its form (ADR
// 0012).
export class Penalized<Input> implements Scorer<Input> {
  readonly #scorer: Scorer<Input>;
  readonly #penalties: readonly Penalty<Input>[];

  constructor(scorer: Scorer<Input>, ...penalties: readonly Penalty<Input>[]) {
    this.#scorer = scorer;
    this.#penalties = penalties;
  }

  score(input: Input): Ratio {
    const ratio = this.#scorer.score(input);
    const factors = this.#penalties.map((penalty) => {
      const factor = penalty.factor(input);
      if (!(factor >= 0 && factor <= 1))
        throw new RangeError(
          `A penalty gave the factor ${factor}, which is not in [0, 1].`,
        );
      return factor;
    });
    if (factors.every((factor) => factor === 1)) return ratio;
    return new Ratio(
      factors.reduce((part, factor) => part * factor, ratio.part),
      ratio.whole,
    );
  }
}
