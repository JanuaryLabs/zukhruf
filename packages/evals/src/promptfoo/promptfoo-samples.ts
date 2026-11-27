import { isDeepStrictEqual } from 'node:util';

import { Ratio } from '../aggregation/ratio.ts';
import type { Sample, Usage } from '../scoring/run-log.ts';
import type { CaseReader, Weighted } from '../scoring/scorecard-scorer.ts';

// The part of promptfoo's EvaluateResult that the samples read (promptfoo
// 0.126.0, dist/src/index.d.ts). The rows of an afterAll extension
// (context.results) and of `promptfoo export eval <id>` (results.results)
// have this shape. The package does not depend on promptfoo.
export type PromptfooResult = {
  readonly testIdx: number;
  readonly promptIdx: number;
  readonly repeatIndex?: number;
  readonly vars: Readonly<Record<string, unknown>>;
  readonly testCase: {
    readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  };
  readonly response?: {
    readonly output?: unknown;
    readonly cached?: boolean;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
  readonly error?: string | null | undefined;
  // promptfoo's ResultFailureReason: 0 none, 1 an assertion failed, 2 an error.
  readonly failureReason: number;
  readonly latencyMs: number;
  readonly namedScores: Readonly<Record<string, number>>;
  readonly gradingResult?: {
    readonly namedScoreWeights?: Readonly<Record<string, number>> | null;
  } | null;
  readonly cost?: number;
  readonly tokenUsage?: {
    readonly prompt?: number | undefined;
    readonly completion?: number | undefined;
    readonly completionDetails?:
      { readonly cacheReadInputTokens?: number | undefined } | undefined;
  };
};

const errorFailureReason = 2;

// How the samples read a row: its test id (promptfoo has no stable one, ADR
// 0004, point 1), its case from the vars, and its answer from the output.
export type PromptfooReaders<Answer, C extends Weighted> = {
  readonly test: (result: PromptfooResult) => string;
  readonly cases: CaseReader<C>;
  readonly answer: (output: unknown) => Answer;
};

// The samples of one promptfoo run, for new RunLog(info, samples) (ADR
// 0009, Adapter and Iterator). The rows are of one prompt: a run of two
// providers is two logs. promptfoo 0.126 gives each execution of a test, each
// repeat too, its own testIdx, in the order of the tests and then of their
// repeats, so testIdx is the key of an answer and its order. Of the rows of
// one testIdx, which a retry with --retry-errors gives twice, the newest wins:
// a row that is not an error, else the error rows, which must have the same
// scores (latestResults of offers-evals' SOB summary, from promptfoo's
// source). A failed call is a failed sample (ADR 0005): a row whose response
// holds FailedCall's `failed` reason, or an error row that an afterEach hook
// graded on the answer null, with the error of the row. An error row with no
// named scores was neither retried nor graded, and is a RangeError.
export class PromptfooSamples<Answer, C extends Weighted> implements Iterable<
  Sample<Answer, C>
> {
  readonly #samples: readonly Sample<Answer, C>[];

  constructor(
    results: readonly PromptfooResult[],
    readers: PromptfooReaders<Answer, C>,
  ) {
    const prompts = [...new Set(results.map(({ promptIdx }) => promptIdx))];
    if (prompts.length > 1)
      throw new RangeError(
        `The samples of a run are the rows of one prompt. Prompts: ${prompts.join(', ')}`,
      );
    const latest = [
      ...Map.groupBy(results, ({ testIdx }) => testIdx).values(),
    ].map((rows) => PromptfooSamples.#latest(rows));
    const errors = latest.filter(
      ({ failureReason, namedScores }) =>
        failureReason === errorFailureReason &&
        Object.keys(namedScores).length === 0,
    );
    if (errors.length > 0)
      throw new RangeError(
        `A run with an error row that no hook graded was not retried; run promptfoo eval with --retry-errors. Errors: ${errors
          .map(
            (result) =>
              `${readers.test(result)} (epoch ${result.repeatIndex ?? 0})${typeof result.error === 'string' ? `: ${result.error}` : ''}`,
          )
          .join(', ')}`,
      );
    this.#samples = latest
      .toSorted((a, b) => a.testIdx - b.testIdx)
      .map((result) => PromptfooSamples.#sample(result, readers));
  }

  [Symbol.iterator](): Iterator<Sample<Answer, C>> {
    return this.#samples.values();
  }

  static #latest(rows: readonly PromptfooResult[]): PromptfooResult {
    const answered = rows.filter(
      ({ failureReason }) => failureReason !== errorFailureReason,
    );
    const [first, ...rest] = answered.length > 0 ? answered : rows;
    if (first === undefined)
      throw new RangeError('A run has a test with no rows');
    if (
      answered.length > 1 ||
      rest.some((row) => !isDeepStrictEqual(row.namedScores, first.namedScores))
    )
      throw new RangeError(
        `Test ${first.testIdx} (epoch ${first.repeatIndex ?? 0}) has ${rows.length} rows, and promptfoo does not tell which is the newest`,
      );
    return first;
  }

  static #sample<Answer, C extends Weighted>(
    result: PromptfooResult,
    readers: PromptfooReaders<Answer, C>,
  ): Sample<Answer, C> {
    const testCase = readers.cases.from(result.vars);
    const graded = result.failureReason !== errorFailureReason;
    // promptfoo writes the weight of each named score of a graded row, 1 when
    // its assertion has none (probe of 2026-11-27, promptfoo 0.126.0). An
    // afterEach hook cannot write the weights of an error row, and promptfoo
    // counts each of its scores with the weight 1 (getNamedMetricContribution,
    // dist/src/evaluator-5tUcjTs8.js:6622-6632 of promptfoo 0.126.0).
    const weights = result.gradingResult?.namedScoreWeights ?? {};
    const facts = {
      test: readers.test(result),
      epoch: result.repeatIndex ?? 0,
      weight: testCase.weight,
      case: testCase,
      scorecard: {
        ratios: new Map(
          Object.entries(result.namedScores).map(([name, score]) => {
            const whole = graded ? weights[name] : (weights[name] ?? 1);
            if (whole === undefined)
              throw new RangeError(
                `Score ${name} of test ${readers.test(result)} has no weight in namedScoreWeights`,
              );
            return [name, new Ratio(score * whole, whole)];
          }),
        ),
      },
      metadata: Object.fromEntries(
        Object.entries(result.testCase.metadata ?? {}).filter(
          (entry): entry is [string, string | number | boolean] =>
            ['string', 'number', 'boolean'].includes(typeof entry[1]),
        ),
      ),
      latencyMs: result.latencyMs,
      call: {
        replayed: result.response?.cached === true,
        usage: PromptfooSamples.#usage(result),
      },
    };
    if (!graded) {
      if (typeof result.error !== 'string')
        throw new RangeError(
          `The error row of test ${readers.test(result)} has no error`,
        );
      return { ...facts, outcome: 'failed', answer: null, error: result.error };
    }
    const failed = result.response?.metadata?.['failed'];
    return typeof failed === 'string'
      ? { ...facts, outcome: 'failed', answer: null, error: failed }
      : {
          ...facts,
          outcome: 'answered',
          answer: readers.answer(result.response?.output),
        };
  }

  // The usage of the call that gave the answer. A row with no tokens and no
  // cost has no usage: promptfoo fills the tokens with 0 when a provider
  // measured none, and a replayed row whose harness kept no usage counts the
  // whole answer under `cached` (ADR 0009, point 6).
  static #usage(result: PromptfooResult): Usage | undefined {
    const tokens = result.tokenUsage;
    if (tokens === undefined) return undefined;
    const input = tokens.prompt ?? 0;
    const output = tokens.completion ?? 0;
    const hasCost = result.cost !== undefined && result.cost > 0;
    if (input === 0 && output === 0 && !hasCost) return undefined;
    return {
      input,
      output,
      cachedInput: tokens.completionDetails?.cacheReadInputTokens ?? 0,
      cost: result.cost,
    };
  }
}
