import { RatioOfSums } from '../../aggregation/ratio-of-sums.ts';
import { Ratio } from '../../aggregation/ratio.ts';
import type { ScorecardScorer } from '../../scoring/scorecard-scorer.ts';
import type { Check, Scorecard } from '../../scoring/scorecard.ts';
import { ComparisonSpec } from '../comparison/comparison-spec.ts';
import { statedData } from '../comparison/json-value.ts';
import { TreeWalk } from '../comparison/tree-walk.ts';
import { Gate } from '../scorers/gate.ts';
import type { Scorer } from '../scorers/scorer.ts';
import type { Case } from './case.ts';
import { PerField } from './per-field.ts';

// Scores a stated value with labelled scorers, through a walk with the spec:
// the ratio of each scorer under its label, and of a PerField under the label
// of each field, so a ratio of sums of a label adds the parts and the wholes
// of the records. The record passes when each of its gates holds, and the
// reason is the explanations of the gates that fail. Each gate is a check.
// The score is the mean of the values of the scorers. A stated text is read
// as json.loads reads it, as a ScorerAssertion reads it; a stated JsonValue
// stays as it is.
export class ScorerSet implements ScorecardScorer<Case> {
  readonly #entries: readonly (readonly [string, Scorer | PerField])[];
  readonly #walk: TreeWalk;

  constructor(
    entries: Readonly<Record<string, Scorer | PerField>>,
    { spec = new ComparisonSpec() }: { readonly spec?: ComparisonSpec } = {},
  ) {
    this.#entries = Object.entries(entries);
    this.#walk = new TreeWalk(spec);
  }

  score(stated: unknown, testCase: Case): Scorecard {
    const comparison = this.#walk.compare(statedData(stated), testCase);
    const ratios: [string, Ratio][] = [];
    const mean = new RatioOfSums();
    const checks: Check[] = [];
    for (const [label, entry] of this.#entries) {
      if (entry instanceof PerField) {
        ratios.push(...entry.ratios(comparison, label));
        continue;
      }
      const ratio = entry.score(comparison);
      ratios.push([label, ratio]);
      mean.add(new Ratio(ratio.value, 1));
      if (entry instanceof Gate) {
        const holds = entry.holds(comparison);
        checks.push({
          name: label,
          passed: holds,
          score: ratio.value,
          reason: holds
            ? `${label} holds`
            : `${label}: ${entry.explain(comparison)}`,
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
