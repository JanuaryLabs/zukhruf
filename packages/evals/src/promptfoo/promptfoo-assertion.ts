import type {
  CaseReader,
  ScorecardScorer,
  Weighted,
} from '../scoring/scorecard-scorer.ts';

// The part of promptfoo's GradingResult that the assertion gives (promptfoo
// 0.125.1, src/types/index.ts). The package does not depend on promptfoo:
// promptfoo reads the plain object.
export type GradingResult = {
  readonly pass: boolean;
  readonly score: number;
  readonly reason: string;
  readonly namedScores?: Readonly<Record<string, number>>;
  readonly namedScoreWeights?: Readonly<Record<string, number>>;
  readonly componentResults?: readonly GradingResult[];
};

// The part of the context that promptfoo gives a javascript assertion: the
// config of the assertion holds the case of the test row.
export type AssertionContext = {
  readonly config?: Readonly<Record<string, unknown>>;
};

// Adapts a scorer to a promptfoo javascript assertion (ADR 0004). Each ratio
// of the scorecard becomes a named score with its whole as the weight, as the
// scorer gave it: promptfoo adds value × weight over the rows and divides by
// the weights (namedMetrics.ts, accumulateNamedMetric), which is the ratio of
// sums. The weight of the case belongs to the case, and Run applies it once
// (ADR 0009, #6359), so the stored weight is not multiplied by it. promptfoo
// calls a function, so a module exports `grade`.
export class PromptfooAssertion<Case extends Weighted> {
  readonly #scorer: ScorecardScorer<Case>;
  readonly #cases: CaseReader<Case>;

  constructor(scorer: ScorecardScorer<Case>, cases: CaseReader<Case>) {
    this.#scorer = scorer;
    this.#cases = cases;
  }

  readonly grade = (
    output: unknown,
    context: AssertionContext,
  ): GradingResult => {
    const testCase = this.#cases.from(context.config ?? {});
    const scorecard = this.#scorer.score(output, testCase);
    const ratios = [...scorecard.ratios];
    return {
      pass: scorecard.passed,
      score: scorecard.score,
      reason: scorecard.reason,
      namedScores: Object.fromEntries(
        ratios.map(([name, ratio]) => [name, ratio.value]),
      ),
      namedScoreWeights: Object.fromEntries(
        ratios.map(([name, ratio]) => [name, ratio.whole]),
      ),
      componentResults: scorecard.checks.map((check) => ({
        pass: check.passed,
        score: check.score,
        reason: check.reason,
      })),
    };
  };
}
