import { MissingVectorError } from './errors.ts';
import { type Keyword, matchesAny } from './keyword.ts';
import type { Stream } from './scorer.ts';
import { Scores, compareIds } from './scores.ts';
import type { Vectors } from './vectors.ts';

// An article of the stream with its similarity to the description, and if
// it matches a keyword.
export type Similar = {
  readonly id: string;
  readonly publishedAt: Date;
  readonly similarity: number;
  readonly match: boolean;
};

// Each article of a non-empty stream, in the order of the stream, with its
// similarity to the description from one query over the publish dates of the
// stream, and its keyword match.
export function similarities(
  vectors: Vectors,
  descriptionVector: readonly number[],
  stream: Stream,
  keywords: readonly Keyword[],
): Similar[] {
  const dates = [...stream.values()].map(({ publishedAt }) =>
    publishedAt.getTime(),
  );
  const found = new Map(
    vectors
      .query(descriptionVector, {
        from: new Date(dates.reduce((a, b) => Math.min(a, b))),
        to: new Date(dates.reduce((a, b) => Math.max(a, b))),
      })
      .map(({ id, similarity }) => [id, similarity]),
  );
  return [...stream].map(([id, { publishedAt, text }]) => {
    const similarity = found.get(id);
    if (similarity === undefined) throw new MissingVectorError(id);
    return { id, publishedAt, similarity, match: matchesAny(keywords, text) };
  });
}

// The keyword order: the matches first, the newest first, and then the other
// articles by similarity. The probability is 1 for a match and 0 for the
// others, and it is not calibrated.
export function keywordRanking(similar: readonly Similar[]): Scores {
  return new Scores(
    new Map(
      similar
        .toSorted((a, b) => {
          if (a.match !== b.match) return a.match ? -1 : 1;
          const key = a.match
            ? b.publishedAt.getTime() - a.publishedAt.getTime()
            : b.similarity - a.similarity;
          return key || compareIds(a.id, b.id);
        })
        .map(({ id, publishedAt, match }) => [
          id,
          { publishedAt, probability: match ? 1 : 0 },
        ]),
    ),
  );
}
