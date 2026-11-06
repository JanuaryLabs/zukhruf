import { RatioOfSums } from '../aggregation/ratio-of-sums.ts';
import { Ratio } from '../aggregation/ratio.ts';
import type { ScorecardScorer } from '../scoring/scorecard-scorer.ts';
import type { Scorecard } from '../scoring/scorecard.ts';
import type { JsonCase } from './json-case.ts';
import { JsonPair } from './json-pair.ts';
import type { Scorer } from './scorer.ts';

// Scores a stated value with labelled scorers: each value is a Ratio(value,
// 1) under its label, so a ratio of sums of a label is the mean of its
// values. The record passes when every value is 1; its score is the mean.
export class ScorerSet implements ScorecardScorer<JsonCase> {
  readonly #scorers: readonly (readonly [string, Scorer])[];

  constructor(scorers: Readonly<Record<string, Scorer>>) {
    this.#scorers = Object.entries(scorers);
  }

  score(stated: unknown, testCase: JsonCase): Scorecard {
    const pair = new JsonPair(stated, testCase);
    const values = this.#scorers.map(
      ([label, scorer]) => [label, scorer.score(pair)] as const,
    );
    const mean = new RatioOfSums();
    for (const [, value] of values) mean.add(new Ratio(value, 1));
    return {
      passed: values.every(([, value]) => value === 1),
      score: mean.value,
      reason: values.map(([label, value]) => `${label} ${value}`).join(', '),
      ratios: new Map(
        values.map(([label, value]) => [label, new Ratio(value, 1)]),
      ),
      checks: values.map(([label, value]) => ({
        name: label,
        passed: value === 1,
        score: value,
        reason: `${label}: ${value}`,
      })),
    };
  }
}
