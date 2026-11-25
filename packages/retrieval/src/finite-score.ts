import type { Passage } from './passage.ts';

/**
 * The score of a passage, for a built-in that reads its value: a score is a
 * finite number. NaN or an infinity is a `TypeError` that names the reader,
 * the passage and, for a fusion, the index of its list, as a missing score is
 * in a score fusion (ADR 0016): in a fusion it turns the scores of its whole
 * list into NaN, and in a sort or a threshold it puts the passage where no
 * score would. Haystack takes it as 0 and logs a warning (`_finite_score` of
 * its `DocumentJoiner`), which hides the bug of whoever wrote the score.
 */
export function finiteScore(
  reader: string,
  passage: Passage,
  score: number,
  list?: number,
): number {
  if (Number.isFinite(score)) return score;
  const where =
    list === undefined ? passage.id : `${passage.id} of list ${list}`;
  throw new TypeError(
    `${reader} reads scores, and the passage ${where} has the score ${score}: a score is a finite number`,
  );
}
