import type { ConfidenceInterval } from './confidence-interval.ts';

// A rule that gives the confidence interval of a bootstrap distribution: the
// method of scipy.stats.bootstrap, such as 'percentile' (Strategy).
export interface ConfidenceIntervalMethod {
  of(distribution: readonly number[]): ConfidenceInterval;
}
