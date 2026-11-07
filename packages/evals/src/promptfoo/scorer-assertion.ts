import type { Scorer } from '../scorers/scorer.ts';
import type { Comparer } from '../scoring/comparer.ts';
import type { CaseReader, Weighted } from '../scoring/scorecard-scorer.ts';
import type { VarsContext } from './assertion-module.ts';

// One scorer with the rule of its promptfoo assertion (ADR 0007, ADR 0013):
// how much it counts in the score of the test (weight: the score is the sum
// of value × weight over the sum of the weights), when it passes (threshold:
// a number passes when it reaches it), and the metric it reports under when
// that is not its name in its assertion module (metric: promptfoo averages
// the values of one metric over the tests, which is a metric in the sense of
// ADR 0009). It is not a promptfoo assertion: promptfoo stores a config as
// JSON, so a config gets a file reference from its AssertionModule, and
// promptfoo loads value from the module. value gets the text of the harness,
// and gives the value of the ratio of the scorer: promptfoo takes the mean of
// the values of one metric, so a SampleAveraged scorer gives its samples
// average. The case comes from the vars of the test, as its case reader reads
// them: an assertion that defaultTest shares gets only the vars of each test.
// The comparer compares the answer with the case and gives the input of the
// scorer.
export class ScorerAssertion<Case extends Weighted, Input> {
  readonly metric: string | undefined;
  readonly weight: number;
  readonly threshold: number;
  readonly value: (output: string, context: VarsContext) => number;

  constructor(
    scorer: Scorer<Input>,
    {
      weight,
      threshold,
      metric,
      comparer,
      cases,
    }: {
      readonly weight: number;
      readonly threshold: number;
      readonly metric?: string;
      readonly comparer: Comparer<Case, Input>;
      readonly cases: CaseReader<Case>;
    },
  ) {
    this.metric = metric;
    this.weight = weight;
    this.threshold = threshold;
    this.value = (output, { vars }) =>
      scorer.score(comparer.compare(output, cases.from(vars))).value;
  }
}
