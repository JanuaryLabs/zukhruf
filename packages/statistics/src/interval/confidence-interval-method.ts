import type { ConfidenceInterval } from './confidence-interval.ts';

// A rule that gives the confidence interval of a bootstrap distribution: the
// method of scipy.stats.bootstrap, such as 'percentile' (Strategy).
export interface ConfidenceIntervalMethod {
  // The share of the bootstrap distribution that the interval covers, such as
  // 0.95: the confidence_level of scipy.stats.bootstrap, the conf of R's
  // boot.ci.
  readonly level: number;
  of(distribution: readonly number[]): ConfidenceInterval;
}
