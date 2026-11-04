import type { JsonCase } from '../paths/json-case.ts';
import { JsonPair } from '../paths/json-pair.ts';
import { statedValue } from '../paths/json-value.ts';
import type { Metric } from '../paths/metric.ts';
import type { CaseReader } from '../scoring/scorer.ts';

// The part of the context that promptfoo gives a javascript assertion that a
// metric assertion reads: the vars of the test (promptfoo 0.125.1,
// AssertionValueFunctionContext).
export type VarsContext = {
  readonly vars: Readonly<Record<string, unknown>>;
};

// Adapts one metric to a promptfoo javascript assertion (ADR 0006). It reads
// the case from the vars of the test, because an assertion that defaultTest
// shares gets only the vars of each test, and it gives the value of the
// metric. The config of the assertion names the value (metric), weighs it in
// the score of the test (weight) and says when it passes (threshold).
// promptfoo calls a function, so a module exports `grade`.
export class MetricAssertion {
  readonly #metric: Metric;
  readonly #cases: CaseReader<JsonCase>;

  constructor(metric: Metric, cases: CaseReader<JsonCase>) {
    this.#metric = metric;
    this.#cases = cases;
  }

  readonly grade = (output: unknown, { vars }: VarsContext): number =>
    this.#metric.of(new JsonPair(statedValue(output), this.#cases.from(vars)));
}
