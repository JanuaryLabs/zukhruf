import type { Label } from './answer-key.ts';

// An article that the reader can show for a yes or no answer.
export type Candidate = {
  readonly id: string;
  // The similarity of the article to the description.
  readonly similarity: number;
  // The article matches a keyword of the profile.
  readonly match: boolean;
  readonly label: Label | undefined;
};

export type Answers = {
  // The shown articles, in the order of the pool.
  readonly shown: readonly string[];
  readonly relevant: readonly string[];
  readonly notRelevant: readonly string[];
};

// Product teaching (round 6, selection-rule.json "teaching"): the reader
// shows the n articles of the pool most similar to the description, and the
// n keyword matches most similar to it. The answer key answers each shown
// article: relevant is a yes, not relevant is a no, and the reader skips an
// ambiguous article. Equal similarities keep the order of the pool, as the
// stable argsort of the research.
export function teach(pool: readonly Candidate[], n: number): Answers {
  const top = (candidates: readonly Candidate[]) =>
    candidates
      .map((candidate, index) => ({ candidate, index }))
      .toSorted(
        (a, b) =>
          b.candidate.similarity - a.candidate.similarity || a.index - b.index,
      )
      .slice(0, n)
      .map(({ candidate }) => candidate.id);
  const chosen = new Set([
    ...top(pool),
    ...top(pool.filter(({ match }) => match)),
  ]);
  const shown = pool.filter(({ id }) => chosen.has(id));
  return {
    shown: shown.map(({ id }) => id),
    relevant: shown.filter(({ label }) => label === true).map(({ id }) => id),
    notRelevant: shown
      .filter(({ label }) => label === undefined)
      .map(({ id }) => id),
  };
}
