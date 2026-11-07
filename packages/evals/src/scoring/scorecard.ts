import type { Ratio } from '../aggregation/ratio.ts';

// One part of a scorecard that passes or fails on its own, such as one field
// of a record.
export type Check = {
  readonly name: string;
  readonly passed: boolean;
  readonly score: number;
  readonly reason: string;
};

// The result of a scorer for one record. The ratios carry their parts and
// wholes, so a runner adds many scorecards into ratios of sums.
export type Scorecard = {
  readonly passed: boolean;
  readonly score: number;
  readonly reason: string;
  readonly ratios: ReadonlyMap<string, Ratio>;
  readonly checks: readonly Check[];
};
