import { JsonPair } from '../paths/json-pair.ts';
import { JsonTextCase } from '../paths/json-text-case.ts';
import { statedValue } from '../paths/json-value.ts';
import type { Scorer } from '../paths/scorer.ts';

// The part of the context that promptfoo gives a javascript assertion that a
// scorer assertion reads: the vars of the test (promptfoo 0.125.1,
// AssertionValueFunctionContext).
export type VarsContext = {
  readonly vars: Readonly<Record<string, unknown>>;
};

// One scorer as a promptfoo javascript assertion (ADR 0007). The object is the
// assertion, so a TypeScript config lists it in its defaultTest. promptfoo
// reads its name (metric: promptfoo averages the values of one name over the
// tests, which is a metric in the sense of ADR 0009), how much it counts in
// the score of the test
// (weight: the score is the sum of value × weight over the sum of the
// weights), and when it passes (threshold: a number passes when it reaches
// it). It calls value with the text of the harness. The case comes from the
// vars of the test, as JsonTextCase reads them: an assertion that defaultTest
// shares gets only the vars of each test, and JSON text keeps 7.0 a float.
export class ScorerAssertion {
  readonly type = 'javascript';
  readonly metric: string;
  readonly weight: number;
  readonly threshold: number;
  readonly value: (output: string, context: VarsContext) => number;

  constructor(
    name: string,
    scorer: Scorer,
    {
      weight,
      threshold,
    }: { readonly weight: number; readonly threshold: number },
  ) {
    this.metric = name;
    this.weight = weight;
    this.threshold = threshold;
    this.value = (output, { vars }) =>
      scorer.score(new JsonPair(statedValue(output), JsonTextCase.from(vars)));
  }
}
