import type { Design } from '../../src/index.ts';

// The parts of a selection rule (eval/rounds/<round>/selection-rule.json)
// that the fitter runs. The other parts are prose for the reader.
export type SelectionRule = {
  readonly data: {
    readonly training: readonly string[];
    readonly regression: readonly string[];
  };
  readonly folds: readonly FoldRule[];
  readonly candidate: {
    readonly name: string;
    // The design without its plan, its threshold and its weights, which the
    // fit gives.
    readonly recipe: Omit<Design, 'planSha256' | 'threshold' | 'pairScore'>;
    readonly thresholds: readonly number[];
  };
  // The scoreboard entry that eligibility compares with, and the family of
  // eligibility E2.
  readonly reference: { readonly design: string; readonly family: string };
};

export type FoldRule = {
  readonly family: string;
  readonly sets: readonly string[];
  // time: contiguous time folds of whole gold events. topic: folds by the
  // rank of the ECB+ topic number, mod count. none: all reports in one fold.
  readonly split: 'time' | 'topic' | 'none';
  readonly count: number;
};
