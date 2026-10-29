import { logistic } from './statistics.ts';

// Adds the naive-Bayes evidence of the keywords to each probability: the log
// likelihood ratio of a match, or of no match, between the relevant articles
// and the stream. P(match | relevant) comes from the taught relevant answers
// and P(match | stream) from the stream, both with Laplace smoothing
// (docs/adr/0002).
export function withKeywordEvidence(
  probabilities: readonly number[],
  streamMatches: readonly boolean[],
  relevantMatches: readonly boolean[],
): number[] {
  const count = (matches: readonly boolean[]) => matches.filter(Boolean).length;
  const relevant = (count(relevantMatches) + 1) / (relevantMatches.length + 2);
  const stream = (count(streamMatches) + 1) / (streamMatches.length + 2);
  const match = Math.log(relevant / stream);
  const miss = Math.log((1 - relevant) / (1 - stream));
  return probabilities.map((probability, index) => {
    const q = Math.min(Math.max(probability, 1e-12), 1 - 1e-12);
    return logistic(
      Math.log(q) - Math.log1p(-q) + (streamMatches[index] ? match : miss),
    );
  });
}
