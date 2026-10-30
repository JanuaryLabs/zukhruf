import type { Scores } from './scores.ts';

// An article of the stream that a scorer scores.
export type Article = {
  // The publish date of the article. A similarity scorer reads the vectors
  // of this date.
  readonly publishedAt: Date;
  // The text of the article, for example the title and the lead. The
  // keywords are matched in it, and a decision model reads it.
  readonly text: string;
};

// The articles to score, by id: one entry for each id. It can be empty.
export type Stream = ReadonlyMap<string, Article>;

// The port of a method that scores a stream for the one interest it was made
// for (docs/adr/0005). The signal stops the score: a scorer that calls a
// model stops its calls, and the score rejects with the reason of the signal
// (docs/adr/0007).
export interface Scorer {
  score(
    stream: Stream,
    options: { readonly signal: AbortSignal },
  ): Promise<Scores>;
}
