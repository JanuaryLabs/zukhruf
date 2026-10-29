import type { Interval } from './bootstrap.ts';

export type Verdict = {
  // pass: all three conditions hold. fail: one does not.
  readonly result: 'pass' | 'fail';
  // The ranker is not worse than the reader's typed keyword list by more
  // than 0.05 MAP: the low end of its interval is above -0.05.
  readonly nonInferiorToKeyword: boolean;
  // The intervals against keywordBroad and newest lie entirely above 0.
  readonly beatsOtherBaselines: boolean;
  readonly intervals: Readonly<Record<string, Interval>>;
};

const MARGIN = 0.05;

// The exam verdict rule of freeze-ranking/plan.json (examVerdictRule.pass),
// on the first and only score of the exam.
export function verdict(
  intervals: Readonly<Record<string, Interval>>,
): Verdict {
  const low = (name: string) => intervals[name]?.low ?? Number.NaN;
  const nonInferiorToKeyword = low('keywordNarrow') > -MARGIN;
  const beatsOtherBaselines = ['keywordBroad', 'newest'].every(
    (name) => low(name) > 0,
  );
  return {
    result: nonInferiorToKeyword && beatsOtherBaselines ? 'pass' : 'fail',
    nonInferiorToKeyword,
    beatsOtherBaselines,
    intervals,
  };
}
