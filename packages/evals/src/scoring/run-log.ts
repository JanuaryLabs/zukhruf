import { Run, pairTests } from './run.ts';
import type { Scorecard } from './scorecard.ts';

// The tokens and the cost of one call (ADR 0007, point 4). cachedInput is the
// part of the input that the provider read from its prompt cache; cost is
// the price of the call when the runner knows it.
export type Usage = {
  readonly input: number;
  readonly output: number;
  readonly cachedInput: number;
  readonly cost: number | undefined;
};

// How the answer of a sample came: a new call, with its usage when the runner
// measured it, or a replay from a cache of the runner or the harness, which
// spent nothing and so has no usage (ADR 0007, point 5).
export type Call =
  | { readonly replayed: false; readonly usage: Usage | undefined }
  | { readonly replayed: true };

type Facts<C> = {
  readonly test: string;
  readonly epoch: number;
  readonly weight: number;
  readonly case: C;
  readonly scorecard: Pick<Scorecard, 'ratios'>;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
  readonly latencyMs: number;
  readonly call: Call;
};

// One answer of a run, to one test, in one epoch (ADR 0007, points 2 and 3):
// answered, with its answer, or failed, with the answer null and its error
// (ADR 0005).
export type Sample<Answer, C> =
  | (Facts<C> & { readonly outcome: 'answered'; readonly answer: Answer })
  | (Facts<C> & {
      readonly outcome: 'failed';
      readonly answer: null;
      readonly error: string;
    });

// The facts of a run: its id, its label (the model or the provider, as the
// runner names it) and its time.
export type RunInfo = {
  readonly id: string;
  readonly label: string;
  readonly createdAt: Date;
};

// The record of one run: its facts and its samples, in the order of the
// iterable that gave them, such as the adapter of a runner (ADR 0007). The
// iterable is read once. Two samples of one test and epoch are a RangeError,
// and so are epochs of one test with other weights, which Run refuses when the
// log builds its run.
export class RunLog<Answer, C> {
  readonly info: RunInfo;
  readonly samples: readonly Sample<Answer, C>[];

  constructor(info: RunInfo, samples: Iterable<Sample<Answer, C>>) {
    this.info = info;
    this.samples = [...samples];
    const seen = new Set<string>();
    const doubled = this.samples.filter(({ test, epoch }) => {
      const key = JSON.stringify([test, epoch]);
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    });
    if (doubled.length > 0)
      throw new RangeError(
        `A run log has one sample for each test and epoch. Twice: ${doubled
          .map(({ test, epoch }) => `${test} (epoch ${epoch})`)
          .join(', ')}`,
      );
    this.run();
  }

  // The Run of ADR 0004: the scorecard of each sample, with the weight of its
  // case, in the order of the samples.
  run(): Run {
    const run = new Run();
    for (const { test, scorecard, weight } of this.samples)
      run.add(test, scorecard, weight);
    return run;
  }
}

// Two run logs on the same tests: a baseline and a change (ADR 0007, point
// 8). A test id that one log does not have, or a test with another weight, is
// a RangeError when the pair is built, so a part that reads a pair never
// meets two logs with other tests.
export class RunPair<Answer, C> {
  readonly baseline: RunLog<Answer, C>;
  readonly change: RunLog<Answer, C>;

  constructor(baseline: RunLog<Answer, C>, change: RunLog<Answer, C>) {
    pairTests(baseline.run(), change.run(), 'A run pair');
    this.baseline = baseline;
    this.change = change;
  }
}
