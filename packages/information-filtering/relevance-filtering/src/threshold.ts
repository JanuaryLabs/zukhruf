import type { Scores } from './scores.ts';

// The port of a rule that turns the probabilities of a stream into a yes or
// no for each article, apart from the ranking (docs/adr/0005).
export interface Threshold {
  // The lowest probability that is accepted. Infinity accepts nothing.
  cut(scores: Scores): number;
}
