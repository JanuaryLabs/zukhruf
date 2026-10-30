import type { Profile } from './profile.ts';
import type { Scores } from './scores.ts';

// The port of a rule that turns the probabilities of a profile into a yes or
// no for each article, apart from the ranking (docs/adr/0005). The profile is
// an input because a threshold can depend on the interest, as in TREC
// adaptive filtering.
export interface Threshold {
  // The lowest probability that is accepted. Infinity accepts nothing.
  cut(scores: Scores, profile: Profile): number;
}
