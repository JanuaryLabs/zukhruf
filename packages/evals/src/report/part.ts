import type { BootstrapInterval } from '@zukhruf/statistics';

import { type Bootstrap, type Ends, RunLog, type Sample } from '../index.ts';

// The value and the interval of one score on some samples; a score with no
// value there has no interval, and the interval says how many resamples it
// comes from.
export type Numbers = {
  readonly value: number;
  readonly ends: Ends;
  readonly interval: BootstrapInterval | undefined;
};

const none: Numbers = {
  value: Number.NaN,
  ends: { low: Number.NaN, high: Number.NaN },
  interval: undefined,
};

// A score on some samples of a log, such as the samples of one key of a
// slice: Run#total and Bootstrap.interval on a RunLog of those samples with
// the facts of the log, so that the interval belongs to the value beside it
// (report ADR 0004). Summary, Slices and ValidityGap read a score on a part
// of a run through it. A score that no sample gives (Run#total throws for
// it) and a score with no whole (Ratio.value gives 0 there, as SOB's ratio()
// does, and a page would read that 0 as a score, report ADR 0002) have no
// value, and the bootstrap is not called for them: its generator keeps its
// state between calls, so an extra call would shift every later interval. A
// score with a value has no interval when no resample has a whole (#6267).
export function measure<Answer, C>(
  log: RunLog<Answer, C>,
  samples: readonly Sample<Answer, C>[],
  name: string,
  bootstrap: Bootstrap,
): Numbers {
  if (!samples.some(({ scorecard }) => scorecard.ratios.has(name))) return none;
  const run = new RunLog(log.info, samples).run();
  const total = run.total(name);
  const value = total.ratio.quotient;
  if (value === undefined) return none;
  const interval = bootstrap.interval(run, name);
  return {
    value,
    ends: {
      low: interval?.low ?? Number.NaN,
      high: interval?.high ?? Number.NaN,
    },
    interval,
  };
}
