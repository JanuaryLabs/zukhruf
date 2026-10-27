import {
  AGREEING_NUMBERS_TERM,
  DISAGREEING_NUMBERS_TERM,
  INTERCEPT,
  SAME_PUBLISHER_TERM,
  SIMILARITY_TERM,
} from './frozen-design.ts';

// What the pair score compares of two reports, other than their leads.
export type Evidence = {
  // The numbers of the title and the body.
  readonly numbers: ReadonlySet<string>;
  // Null when the caller gave no publisher.
  readonly publisher: string | null;
};

// The probability that two reports report one event, from the cosine
// similarity of their leads, the numbers of their full texts and their
// publishers. Numbers that both reports give are evidence for one event.
// Numbers that only one report gives are evidence against it (the Fellegi and
// Sunter model). One publisher is evidence against one event: at the same
// similarity, two reports of one publisher report one event less often than
// two reports of two publishers, because a publisher writes many reports on
// one topic (docs/adr/0005).
export function pairScore(
  similarity: number,
  a: Evidence,
  b: Evidence,
): number {
  const shared = [...a.numbers].filter((number) =>
    b.numbers.has(number),
  ).length;
  const samePublisher = a.publisher !== null && a.publisher === b.publisher;
  const z =
    INTERCEPT +
    term(SIMILARITY_TERM, similarity) +
    term(AGREEING_NUMBERS_TERM, Math.log1p(shared)) +
    term(
      DISAGREEING_NUMBERS_TERM,
      Math.log1p(Math.min(a.numbers.size - shared, b.numbers.size - shared)),
    ) +
    term(SAME_PUBLISHER_TERM, samePublisher ? 1 : 0);
  return 1 / (1 + Math.exp(-z));
}

function term(
  { weight, mean, sd }: { weight: number; mean: number; sd: number },
  value: number,
): number {
  return (weight * (value - mean)) / sd;
}
