import type { Scorecard } from './scorecard.ts';

// What every case gives besides its own data: how much it counts in a
// weighted average.
export type Weighted = { readonly weight: number };

// Scores one stated record against its case. A scorer keeps no result, so
// one scorer scores any number of records.
export interface ScorecardScorer<Case extends Weighted> {
  score(stated: unknown, testCase: Case): Scorecard;
}

// Reads a case from the plain object that a runner holds for one test, such
// as the config of a promptfoo assertion or the vars of a promptfoo test. A
// case class gives it as its static `from`.
export interface CaseReader<Case extends Weighted> {
  from(config: Readonly<Record<string, unknown>>): Case;
}
