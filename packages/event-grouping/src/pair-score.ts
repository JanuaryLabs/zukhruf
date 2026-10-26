import {
  AGREEING_NUMBERS_TERM,
  DISAGREEING_NUMBERS_TERM,
  INTERCEPT,
  SIMILARITY_TERM,
} from './frozen-design.ts';

// The probability that two reports report one event, from the cosine
// similarity of their leads and the numbers of their full texts. Numbers that
// both reports give are evidence for one event. Numbers that only one report
// gives are evidence against it (the Fellegi and Sunter model).
export function pairScore(
  similarity: number,
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): number {
  const shared = [...a].filter((number) => b.has(number)).length;
  const z =
    INTERCEPT +
    term(SIMILARITY_TERM, similarity) +
    term(AGREEING_NUMBERS_TERM, Math.log1p(shared)) +
    term(
      DISAGREEING_NUMBERS_TERM,
      Math.log1p(Math.min(a.size - shared, b.size - shared)),
    );
  return 1 / (1 + Math.exp(-z));
}

function term(
  { weight, mean, sd }: { weight: number; mean: number; sd: number },
  value: number,
): number {
  return (weight * (value - mean)) / sd;
}
