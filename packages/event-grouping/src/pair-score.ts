import type { Design } from './design.ts';

// What the pair score compares of two reports, other than their leads.
export type Evidence = {
  // The numbers of the title and the body.
  readonly numbers: ReadonlySet<string>;
  // Null when the caller gave no publisher.
  readonly publisher: string | null;
};

// The features of the pair score, in the order of its terms.
export const PAIR_FEATURES = [
  'similarity',
  'agreeingNumbers',
  'disagreeingNumbers',
  'samePublisher',
  'samePublisherSimilarity',
] as const;

export type PairFeature = (typeof PAIR_FEATURES)[number];

export type PairFeatures = Record<PairFeature, number>;

// The features of two reports, from the cosine similarity of their leads, the
// numbers of their full texts and their publishers. The detector scores a
// pair with them, and the fitter (eval/fit) fits the weights on them.
export function pairFeatures(
  similarity: number,
  a: Evidence,
  b: Evidence,
): PairFeatures {
  const shared = [...a.numbers].filter((number) =>
    b.numbers.has(number),
  ).length;
  const samePublisher =
    a.publisher !== null && a.publisher === b.publisher ? 1 : 0;
  return {
    similarity,
    agreeingNumbers: Math.log1p(shared),
    disagreeingNumbers: Math.log1p(
      Math.min(a.numbers.size - shared, b.numbers.size - shared),
    ),
    samePublisher,
    samePublisherSimilarity: samePublisher * similarity,
  };
}

// The probability that two reports report one event. Numbers that both
// reports give are evidence for one event. Numbers that only one report gives
// are evidence against it (the Fellegi and Sunter model). One publisher is
// evidence against one event: at the same similarity, two reports of one
// publisher report one event less often than two reports of two publishers,
// because a publisher writes many reports on one topic (docs/adr/0005). A
// term that the model does not have is not in the score.
export function pairScore(
  model: Design['pairScore'],
  features: PairFeatures,
): number {
  const z = PAIR_FEATURES.reduce((sum, feature) => {
    const term = model[feature];
    return term === undefined
      ? sum
      : sum + (term.weight * (features[feature] - term.mean)) / term.sd;
  }, model.intercept);
  return 1 / (1 + Math.exp(-z));
}
