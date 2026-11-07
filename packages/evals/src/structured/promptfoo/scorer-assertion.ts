import type { Scorer } from '../../scorers/scorer.ts';
import type { CaseReader } from '../../scoring/scorecard-scorer.ts';
import { ComparisonSpec } from '../comparison/comparison-spec.ts';
import type { Comparison } from '../comparison/comparison.ts';
import { statedData } from '../comparison/json-value.ts';
import { TreeWalk } from '../comparison/tree-walk.ts';
import type { Case } from '../scoring/case.ts';
import { TextVarsCase } from '../scoring/text-vars-case.ts';

// The part of the context that promptfoo gives a javascript assertion that a
// scorer assertion reads: the vars of the test (promptfoo 0.125.1,
// AssertionValueFunctionContext).
export type VarsContext = {
  readonly vars: Readonly<Record<string, unknown>>;
};

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
// them (a TextVarsCase that reads each schema with the draft of its $schema,
// unless the caller gives one): an assertion that defaultTest shares gets
// only the vars of each test, and JSON text keeps 7.0 a float. The spec tells
// the walk how to compare the answer with the case.
export class ScorerAssertion {
  readonly metric: string | undefined;
  readonly weight: number;
  readonly threshold: number;
  readonly value: (output: string, context: VarsContext) => number;

  constructor(
    scorer: Scorer<Comparison>,
    {
      weight,
      threshold,
      metric,
      spec = new ComparisonSpec(),
      cases = new TextVarsCase(),
    }: {
      readonly weight: number;
      readonly threshold: number;
      readonly metric?: string;
      readonly spec?: ComparisonSpec;
      readonly cases?: CaseReader<Case>;
    },
  ) {
    this.metric = metric;
    this.weight = weight;
    this.threshold = threshold;
    const walk = new TreeWalk(spec);
    this.value = (output, { vars }) =>
      scorer.score(walk.compare(statedData(output), cases.from(vars))).value;
  }
}
