import type { Interval } from './bootstrap.ts';

export type Verdict = {
  // pass: all four conditions hold. fail: one does not.
  readonly result: 'pass' | 'fail';
  // The design is not worse than the reader's typed keyword by more than
  // 0.05 macro T11F: the low end of its interval is above -0.05.
  readonly nonInferiorToKeyword: boolean;
  // The intervals against keywordBroad, alwaysNo and alwaysYes lie entirely
  // above 0.
  readonly beatsOtherBaselines: boolean;
  // The macro Brier skill is above 0: the probabilities beat the exam base
  // rate.
  readonly calibrated: boolean;
  readonly intervals: Readonly<Record<string, Interval>>;
};

const MARGIN = 0.05;

// The exam verdict rule of freeze/plan.json (examVerdictRule.pass), on the
// first and only score of the exam.
export function verdict(options: {
  readonly intervals: Readonly<Record<string, Interval>>;
  readonly macroBrierSkill: number;
}): Verdict {
  const { intervals, macroBrierSkill } = options;
  const low = (name: string) => intervals[name]?.low ?? Number.NaN;
  const nonInferiorToKeyword = low('keywordNarrow') > -MARGIN;
  const beatsOtherBaselines = ['keywordBroad', 'alwaysNo', 'alwaysYes'].every(
    (name) => low(name) > 0,
  );
  const calibrated = macroBrierSkill > 0;
  return {
    result:
      nonInferiorToKeyword && beatsOtherBaselines && calibrated
        ? 'pass'
        : 'fail',
    nonInferiorToKeyword,
    beatsOtherBaselines,
    calibrated,
    intervals,
  };
}
