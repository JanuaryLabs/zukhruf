import type { Profile } from './profile.ts';
import type { Scores } from './scores.ts';

// An article of the stream that a scorer scores.
export type Article = {
  readonly id: string;
  // The publish date of the article. A similarity scorer reads the vectors
  // of this date.
  readonly publishedAt: Date;
  // The text of the article, for example the title and the lead. The
  // keywords are matched in it, and a decision model reads it.
  readonly text: string;
};

// The articles to score: one or more.
export type Stream = readonly [Article, ...Article[]];

// The port of a method that scores the stream for a profile (docs/adr/0005).
export interface Scorer {
  score(profile: Profile, stream: Stream): Promise<Scores>;
}
