import type { Vectors } from '../src/index.ts';
import type { Label } from './answer-key.ts';
import { runDesign } from './design.ts';
import type { EvalProfile } from './profiles.ts';
import type { StreamArticle } from './runs.ts';
import type { LoadedSet } from './slice.ts';
import { type Candidate, teach } from './teaching.ts';

export const RANKER = 'desc+kw';
export const RANKING_BASELINES = [
  'keywordNarrow',
  'keywordBroad',
  'newest',
] as const;
export type RankName = typeof RANKER | (typeof RANKING_BASELINES)[number];

// An object with one value for the ranker and each baseline.
export function byRank<T>(value: (name: RankName) => T): Record<RankName, T> {
  return {
    [RANKER]: value(RANKER),
    keywordNarrow: value('keywordNarrow'),
    keywordBroad: value('keywordBroad'),
    newest: value('newest'),
  };
}

// One ranking run of a profile: teaching from a pool with N shown articles
// of each kind, and the order of the stream by each list.
export type RankingUnit = {
  readonly taughtRelevant: number;
  readonly taughtNotRelevant: number;
  readonly scoredRelevant: number;
  readonly orders: Readonly<Record<RankName, readonly string[]>>;
  readonly ap: Readonly<Record<RankName, number>>;
};

// The articles of the sets as a teaching pool for one profile, in the order
// of the sets and then of their queue numbers.
export function poolOf(
  sets: readonly LoadedSet[],
  profile: EvalProfile,
  descriptionVector: readonly number[],
  include: (set: LoadedSet, index: number) => boolean = () => true,
): Candidate[] {
  return sets.flatMap((set) => {
    const similarities = set.similarities(descriptionVector);
    const narrow = set.matches(profile.narrow);
    const labels = set.labelsFor(profile.id);
    return set.articles.flatMap(({ id }, index) =>
      include(set, index)
        ? [
            {
              id,
              similarity: similarities[index] ?? Number.NaN,
              match: narrow[index] ?? false,
              label: labels[index],
            },
          ]
        : [],
    );
  });
}

// The articles of a set as a stream for one profile.
export function streamOf(
  set: LoadedSet,
  profile: EvalProfile,
  include: (index: number) => boolean = () => true,
): [StreamArticle, ...StreamArticle[]] {
  const narrow = set.matches(profile.narrow);
  const broad = set.matches(profile.broad);
  const labels = set.labelsFor(profile.id);
  const [first, ...rest] = set.articles.flatMap((article, index) =>
    include(index)
      ? [
          {
            ...article,
            text: set.textOf(article.id),
            label: labels[index],
            narrow: narrow[index] ?? false,
            broad: broad[index] ?? false,
          },
        ]
      : [],
  );
  if (first === undefined) throw new Error(`${set.set.name} has no stream.`);
  return [first, ...rest];
}

// Teaches the profile from the pool, ranks the stream through the package,
// and scores the ranking and the baselines by average precision (round-10
// evaluate.py, unit_run).
export function runRankingUnit(options: {
  readonly profile: EvalProfile;
  readonly pool: readonly Candidate[];
  readonly n: number;
  readonly stream: readonly [StreamArticle, ...StreamArticle[]];
  readonly vectors: Vectors;
  readonly descriptionVector: readonly number[];
  readonly textOf: (id: string) => string;
}): RankingUnit {
  const { stream } = options;
  const answers = teach(options.pool, options.n);
  const filter = runDesign({
    profile: options.profile,
    keyword: options.profile.narrow,
    answers,
    vectors: options.vectors,
    descriptionVector: options.descriptionVector,
    stream,
    textOf: options.textOf,
  });
  const orders = byRank((name) => {
    if (name === RANKER) return filter.ranked();
    if (name === 'newest') return newestFirst(stream, () => false);
    return newestFirst(stream, (article) => article[narrowOrBroad(name)]);
  });
  const labels = new Map(stream.map(({ id, label }) => [id, label]));
  return {
    taughtRelevant: answers.relevant.length,
    taughtNotRelevant: answers.notRelevant.length,
    scoredRelevant: stream.filter(({ label }) => label === true).length,
    orders,
    ap: byRank((name) => averagePrecision(orders[name], labels)),
  };
}

function narrowOrBroad(name: 'keywordNarrow' | 'keywordBroad') {
  return name === 'keywordNarrow' ? 'narrow' : 'broad';
}

// A keyword list: the matches first, then the other articles; inside each
// group the newest first, and equal dates by id. With no match, the newest
// first.
export function newestFirst(
  stream: readonly StreamArticle[],
  match: (article: StreamArticle) => boolean,
): string[] {
  return stream
    .toSorted(
      (a, b) =>
        Number(match(b)) - Number(match(a)) ||
        b.publishedAt.getTime() - a.publishedAt.getTime() ||
        compareIds(a.id, b.id),
    )
    .map(({ id }) => id);
}

// The average precision of a ranking over its labelled articles: the
// ambiguous articles are left out, and AP is the mean over the relevant
// articles of the precision at their rank. NaN with no relevant article.
export function averagePrecision(
  order: readonly string[],
  labels: ReadonlyMap<string, Label | undefined>,
  weights?: ReadonlyMap<string, number>,
): number {
  let seen = 0;
  let relevant = 0;
  let total = 0;
  for (const id of order) {
    const label = labels.get(id);
    if (label === null) continue;
    const weight = weights?.get(id) ?? 1;
    // An article drawn w times takes w ranks next to each other.
    for (let copy = 0; copy < weight; copy++) {
      seen++;
      if (label === true) {
        relevant++;
        total += relevant / seen;
      }
    }
  }
  return relevant === 0 ? Number.NaN : total / relevant;
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
