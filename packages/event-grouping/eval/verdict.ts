import type { Interval } from './bootstrap.ts';

export type Verdict = {
  // pass: the candidate replaces the accepted design. inconclusive: the
  // accepted design stays. fail: the candidate is worse, or it does not beat
  // a baseline, or it is worse on a regression set.
  readonly result: 'pass' | 'inconclusive' | 'fail';
  // (a) The 95% interval of (candidate - accepted) on the exam.
  readonly exam: Interval;
  // (b) The main score of the candidate on the exam is greater than both
  // baselines.
  readonly beatsBaselines: boolean;
  // (c) No regression set has an interval entirely below 0.
  readonly regressionSets: Readonly<Record<string, Interval>>;
  readonly noRegression: boolean;
};

// The exam verdict rule of round 3152b (eval/rounds/3152b/selection-rule.json
// examVerdict), on the first and only score of an exam set.
export function verdict(options: {
  readonly exam: Interval;
  readonly mainScore: number;
  readonly baselines: readonly number[];
  readonly regressionSets: Readonly<Record<string, Interval>>;
}): Verdict {
  const { exam, mainScore, baselines, regressionSets } = options;
  const beatsBaselines = mainScore > Math.max(...baselines);
  const noRegression = Object.values(regressionSets).every(
    (interval) => interval.high >= 0,
  );
  let result: Verdict['result'] = 'inconclusive';
  if (!beatsBaselines || !noRegression || exam.high < 0) result = 'fail';
  else if (exam.low > 0) result = 'pass';
  return { result, exam, beatsBaselines, regressionSets, noRegression };
}
