import { RatioOfSums } from '../aggregation/ratio-of-sums.ts';
import { Ratio } from '../aggregation/ratio.ts';
import { Gate } from '../scorers/gate.ts';
import type { Scorer } from '../scorers/scorer.ts';
import type { Comparer } from './comparer.ts';
import { Grouped } from './grouped.ts';
import type { ScorecardScorer, Weighted } from './scorecard-scorer.ts';
import type { Check, Scorecard } from './scorecard.ts';

// Scores a stated value with labelled scorers, on the input that the comparer
// gives: the ratio of each scorer under its label, and of a Grouped scorer
// under the label of each group, so a ratio of sums of a label adds the parts
// and the wholes of the records. The record passes when each of its gates
// holds, and the reason is the explanations of the gates that fail. Each gate
// is a check. The score is the mean of the values of the scorers.
export class ScorerSet<
  Case extends Weighted,
  Input,
> implements ScorecardScorer<Case> {
  readonly #entries: readonly (readonly [
    string,
    Scorer<Input> | Grouped<Input>,
  ])[];
  readonly #comparer: Comparer<Case, Input>;

  constructor(
    entries: Readonly<Record<string, Scorer<Input> | Grouped<Input>>>,
    { comparer }: { readonly comparer: Comparer<Case, Input> },
  ) {
    this.#entries = Object.entries(entries);
    this.#comparer = comparer;
  }

  score(stated: unknown, testCase: Case): Scorecard {
    const input = this.#comparer.compare(stated, testCase);
    const ratios: [string, Ratio][] = [];
    const mean = new RatioOfSums();
    const checks: Check[] = [];
    for (const [label, entry] of this.#entries) {
      if (entry instanceof Grouped) {
        ratios.push(...entry.ratios(input, label));
        continue;
      }
      const ratio = entry.score(input);
      ratios.push([label, ratio]);
      mean.add(new Ratio(ratio.value, 1));
      if (entry instanceof Gate) {
        const holds = entry.holds(input);
        checks.push({
          name: label,
          passed: holds,
          score: ratio.value,
          reason: holds
            ? `${label} holds`
            : `${label}: ${entry.explain(input)}`,
        });
      }
    }
    const failed = checks.filter((check) => !check.passed);
    return {
      passed: failed.length === 0,
      score: mean.value,
      reason:
        failed.length === 0
          ? 'each gate holds'
          : failed.map((check) => check.reason).join('; '),
      ratios: new Map(ratios),
      checks,
    };
  }
}
