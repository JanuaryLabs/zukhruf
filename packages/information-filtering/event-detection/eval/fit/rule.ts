import type { Design } from '../../src/index.ts';
import type { PairFeature } from '../../src/pair-score.ts';

// The parts of a selection rule (eval/rounds/<round>/selection-rule.json)
// that the fitter runs. The other parts are prose for the reader.
export type SelectionRule = {
  readonly data: {
    readonly training: readonly string[];
    readonly regression: readonly string[];
  };
  readonly folds: readonly FoldRule[];
  // Each candidate gets its own fitted weights and threshold.
  readonly candidates: readonly Candidate[];
  // The scoreboard entry that E3 compares with on the regression sets.
  readonly reference: { readonly design: string };
  // E2: on the family, the nested-CV score of a candidate must be greater
  // than that of the reference design as it is, or than the nested-CV score
  // of the named candidate.
  readonly e2: {
    readonly family: string;
    readonly against: 'reference' | { readonly candidate: string };
  };
  // Without a choice, the one candidate is chosen when it is eligible. With
  // one, the eligible challenger with the best objective is chosen only when
  // the paired bootstrap interval of (challenger - incumbent) on the nested-CV
  // objective is entirely above 0. Otherwise no candidate is chosen.
  readonly choice?: {
    readonly incumbent: string;
    readonly challengers: readonly string[];
  };
};

export type Candidate = {
  readonly name: string;
  // The design without its plan, its threshold and its weights, which the
  // fit gives.
  readonly recipe: Omit<Design, 'planSha256' | 'threshold' | 'pairScore'>;
  readonly thresholds: readonly number[];
  // The terms of the pair score that the fit gives weights. Without it, the
  // four terms of design 3152b (FOUR_FEATURES).
  readonly features?: readonly PairFeature[];
};

export const FOUR_FEATURES: readonly PairFeature[] = [
  'similarity',
  'agreeingNumbers',
  'disagreeingNumbers',
  'samePublisher',
];

export function featuresOf(candidate: Candidate): readonly PairFeature[] {
  return candidate.features ?? FOUR_FEATURES;
}

export type FoldRule = {
  readonly family: string;
  readonly sets: readonly string[];
  // time: contiguous time folds of whole gold events. topic: folds by the
  // rank of the ECB+ topic number, mod count. none: all reports in one fold.
  readonly split: 'time' | 'topic' | 'none';
  readonly count: number;
};
