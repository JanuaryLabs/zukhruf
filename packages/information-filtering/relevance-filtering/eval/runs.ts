import type { Article, RelevanceFilter, Vectors } from '../src/index.ts';
import type { Label } from './answer-key.ts';
import { runDesign } from './design.ts';
import { type Scores, scores } from './metrics.ts';
import type { EvalProfile } from './profiles.ts';
import { type Candidate, teach } from './teaching.ts';

export const DESIGN = 'desc|binormal+kw';
export const BASELINES = [
  'alwaysNo',
  'alwaysYes',
  'keywordNarrow',
  'keywordBroad',
] as const;
export type Name = typeof DESIGN | (typeof BASELINES)[number];

// An object with one value for the design and each baseline.
export function byName<T>(value: (name: Name) => T): Record<Name, T> {
  return {
    [DESIGN]: value(DESIGN),
    alwaysNo: value('alwaysNo'),
    alwaysYes: value('alwaysYes'),
    keywordNarrow: value('keywordNarrow'),
    keywordBroad: value('keywordBroad'),
  };
}

// One run of a profile: a teaching pool, a stream and a number N of shown
// articles of each kind.
export type Unit = {
  readonly taughtRelevant: number;
  readonly taughtNotRelevant: number;
  readonly scoredRelevant: number;
  // The design had no relevant answer, so it accepted the keyword matches.
  readonly keywordFallback: boolean;
  // Strict: ambiguous articles are left out. ambiguousRelevant: they count as
  // relevant.
  readonly rows: Readonly<
    Record<
      Name,
      { readonly strict: Scores; readonly ambiguousRelevant: Scores }
    >
  >;
  // The decision of each design on each stream article.
  readonly accepted: Readonly<Record<Name, readonly boolean[]>>;
};

export type StreamArticle = Article & {
  readonly label: Label | undefined;
  readonly narrow: boolean;
  readonly broad: boolean;
};

// Teaches the profile from the pool by product teaching, runs the design on
// the stream, and scores it with the baselines (round-6 evaluate.py,
// unit_run).
export function runUnit(options: {
  readonly profile: EvalProfile;
  readonly pool: readonly Candidate[];
  readonly n: number;
  readonly stream: readonly [StreamArticle, ...StreamArticle[]];
  readonly vectors: Vectors;
  readonly descriptionVector: readonly number[];
  readonly textOf: (id: string) => string;
}): Unit {
  const { stream } = options;
  const answers = teach(options.pool, options.n);
  const filter: RelevanceFilter = runDesign({
    profile: options.profile,
    keyword: options.profile.narrow,
    answers,
    vectors: options.vectors,
    descriptionVector: options.descriptionVector,
    stream,
    textOf: options.textOf,
  });
  const decisions: Record<Name, { p: number[]; accepted: boolean[] }> = {
    alwaysNo: { p: stream.map(() => 0), accepted: stream.map(() => false) },
    alwaysYes: { p: stream.map(() => 1), accepted: stream.map(() => true) },
    keywordNarrow: {
      p: stream.map(({ narrow }) => (narrow ? 1 : 0)),
      accepted: stream.map(({ narrow }) => narrow),
    },
    keywordBroad: {
      p: stream.map(({ broad }) => (broad ? 1 : 0)),
      accepted: stream.map(({ broad }) => broad),
    },
    [DESIGN]: {
      p: stream.map(({ id }) => filter.probability(id)),
      accepted: stream.map(({ id }) => filter.accepts(id)),
    },
  };
  const labelled = stream.map(({ label }) => label !== null);
  const strict = <T>(values: readonly T[]) =>
    values.filter((_, index) => labelled[index]);
  const relevant = stream.map(({ label }) => label === true);
  const relevantOrAmbiguous = stream.map(({ label }) => label !== undefined);
  return {
    taughtRelevant: answers.relevant.length,
    taughtNotRelevant: answers.notRelevant.length,
    scoredRelevant: relevant.filter(Boolean).length,
    keywordFallback: filter.kind === 'keywords',
    rows: byName((name) => {
      const { p, accepted } = decisions[name];
      return {
        strict: scores(strict(accepted), strict(p), strict(relevant)),
        ambiguousRelevant: scores(accepted, p, relevantOrAmbiguous),
      };
    }),
    accepted: byName((name) => decisions[name].accepted),
  };
}
