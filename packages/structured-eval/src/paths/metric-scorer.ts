import { RatioOfSums } from '../aggregation/ratio-of-sums.ts';
import { Ratio } from '../aggregation/ratio.ts';
import type { Scorecard } from '../scoring/scorecard.ts';
import type { Scorer } from '../scoring/scorer.ts';
import type { JsonCase } from './json-case.ts';
import { JsonPair } from './json-pair.ts';
import type { Metric } from './metric.ts';

// Scores a stated value with labelled metrics: each value is a Ratio(value,
// 1) under its label, so a ratio of sums of a label is the mean of its
// values. The record passes when every value is 1; its score is the mean.
export class MetricScorer implements Scorer<JsonCase> {
  readonly #metrics: readonly (readonly [string, Metric])[];

  constructor(metrics: Readonly<Record<string, Metric>>) {
    this.#metrics = Object.entries(metrics);
  }

  score(stated: unknown, testCase: JsonCase): Scorecard {
    const pair = new JsonPair(stated, testCase);
    const values = this.#metrics.map(
      ([label, metric]) => [label, metric.of(pair)] as const,
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
