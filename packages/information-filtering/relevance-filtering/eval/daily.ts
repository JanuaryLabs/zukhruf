import type { Label } from './answer-key.ts';
import { type Interval, topicBootstrap } from './bootstrap.ts';
import { joined, runDesign } from './design.ts';
import { mean } from './metrics.ts';
import { NumpyGenerator } from './numpy-random.ts';
import type { EvalProfile } from './profiles.ts';
import { newestFirst, poolOf, streamOf } from './ranking.ts';
import type { StreamArticle } from './runs.ts';
import type { LoadedSet } from './slice.ts';
import { teach } from './teaching.ts';

// Research round 11 (#3308, round-11/selection-rule.json, sha256
// 7d555bdf…): the best-N-a-day list against a keyword list, per UTC publish
// day (README.md, "Round 11").

export const N_DAY = [3, 5, 10] as const;
export const N_TEACH = [5, 10] as const;
export const LISTS = ['ranker', 'keyword', 'newest'] as const;
export type List = (typeof LISTS)[number];
const DAY_MS = 86_400_000;
const MIN_DAYS = 20;
const SEED = 31964;

// What one list showed on one day, for one N_day.
type Shown = readonly string[];

// The scores of one list for one profile, mean over days, then over N_day
// and N_teach. NaN when no day counts.
export type DailyScores = {
  // Main: relevant shown / relevant of the day, over days with a strict
  // relevant article.
  readonly recall: number;
  // Relevant shown / shown without the ambiguous articles, over days where
  // the list shows at least one article that is not ambiguous.
  readonly precision: number;
  // Share of the days of the slice where the list shows nothing.
  readonly emptyDays: number;
  // Share of the days with a relevant article where the list shows none of
  // them.
  readonly missedDays: number;
};

// The equal-count comparison: on each day the ranker is cut to the number
// of articles that the keyword list showed that day (k_day).
export type EqualCount = {
  readonly ranker: { readonly recall: number; readonly precision: number };
  readonly keyword: { readonly recall: number; readonly precision: number };
};

export type ProfileResult = {
  readonly relevantDays: number;
  readonly lists: Readonly<Record<List, DailyScores>>;
  readonly equalCount: EqualCount;
};

// The UTC publish day of an article, as YYYY-MM-DD.
function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// The scores of a set of shown lists, one per day, against the labels.
export function dayScores(
  days: readonly string[],
  shownOn: (day: string) => Shown,
  articlesOn: ReadonlyMap<string, readonly StreamArticle[]>,
) {
  const recall: number[] = [];
  const precision: number[] = [];
  let empty = 0;
  let missed = 0;
  for (const day of days) {
    const shown = shownOn(day);
    const articles = articlesOn.get(day) ?? [];
    const label = new Map(articles.map(({ id, label }) => [id, label]));
    const relevant = articles.filter(({ label }) => label === true).length;
    const hits = shown.filter((id) => label.get(id) === true).length;
    const judged = shown.filter((id) => label.get(id) !== null).length;
    if (shown.length === 0) empty++;
    if (judged > 0) precision.push(hits / judged);
    if (relevant > 0) {
      recall.push(hits / relevant);
      if (hits === 0) missed++;
    }
  }
  return {
    recall: recall.length > 0 ? mean(recall) : Number.NaN,
    precision: precision.length > 0 ? mean(precision) : Number.NaN,
    emptyDays: days.length > 0 ? empty / days.length : Number.NaN,
    missedDays: recall.length > 0 ? missed / recall.length : Number.NaN,
  };
}

// Round 11 for every profile: teach from the pool, rank the whole test slice
// through the package, and compare the lists of each day.
export function daily(options: {
  readonly profiles: readonly EvalProfile[];
  readonly descriptionOf: (profile: EvalProfile) => readonly number[];
  readonly test: LoadedSet;
  readonly pool: readonly LoadedSet[];
}) {
  const { test, pool } = options;
  const vectors = joined(
    test.collection,
    pool.map(({ collection }) => collection),
  );
  const textOf = (id: string) =>
    [test, ...pool].find(({ texts }) => texts.has(id))?.textOf(id) ?? '';
  const results: Record<string, ProfileResult> = {};
  for (const profile of options.profiles) {
    const descriptionVector = options.descriptionOf(profile);
    const candidates = poolOf(pool, profile, descriptionVector);
    const stream = streamOf(test, profile);
    const articlesOn = Map.groupBy(stream, ({ publishedAt }) =>
      dayOf(publishedAt),
    );
    const days = [...articlesOn.keys()].toSorted();
    const relevantDays = days.filter((day) =>
      (articlesOn.get(day) ?? []).some(({ label }) => label === true),
    ).length;
    const per: Record<List, ReturnType<typeof dayScores>[]> = {
      ranker: [],
      keyword: [],
      newest: [],
    };
    const equal: Record<
      'ranker' | 'keyword',
      { recall: number[]; precision: number[] }
    > = {
      ranker: { recall: [], precision: [] },
      keyword: { recall: [], precision: [] },
    };
    for (const nTeach of N_TEACH) {
      const filter = runDesign({
        profile,
        keyword: profile.narrow,
        answers: teach(candidates, nTeach),
        vectors,
        descriptionVector,
        stream,
        textOf,
      });
      const ranked = new Map(
        days.map((day) => {
          const from = new Date(`${day}T00:00:00.000Z`);
          return [
            day,
            filter.ranked({ from, to: new Date(from.getTime() + DAY_MS - 1) }),
          ];
        }),
      );
      const keyword = new Map(
        days.map((day) => [
          day,
          newestFirst(
            (articlesOn.get(day) ?? []).filter(({ narrow }) => narrow),
            () => false,
          ),
        ]),
      );
      const newest = new Map(
        days.map((day) => [
          day,
          newestFirst(articlesOn.get(day) ?? [], () => false),
        ]),
      );
      for (const nDay of N_DAY) {
        const cut =
          (lists: ReadonlyMap<string, readonly string[]>) => (day: string) =>
            (lists.get(day) ?? []).slice(0, nDay);
        per.ranker.push(dayScores(days, cut(ranked), articlesOn));
        per.keyword.push(dayScores(days, cut(keyword), articlesOn));
        per.newest.push(dayScores(days, cut(newest), articlesOn));
        const k = (day: string) => cut(keyword)(day).length;
        const atK = dayScores(
          days,
          (day) => (ranked.get(day) ?? []).slice(0, k(day)),
          articlesOn,
        );
        const keywordAtK = dayScores(days, cut(keyword), articlesOn);
        equal.ranker.recall.push(atK.recall);
        equal.ranker.precision.push(atK.precision);
        equal.keyword.recall.push(keywordAtK.recall);
        equal.keyword.precision.push(keywordAtK.precision);
      }
    }
    const average = (rows: ReturnType<typeof dayScores>[]): DailyScores => ({
      recall: mean(rows.map(({ recall }) => recall)),
      precision: nanMeanOf(rows.map(({ precision }) => precision)),
      emptyDays: mean(rows.map(({ emptyDays }) => emptyDays)),
      missedDays: mean(rows.map(({ missedDays }) => missedDays)),
    });
    results[profile.id] = {
      relevantDays,
      lists: {
        ranker: average(per.ranker),
        keyword: average(per.keyword),
        newest: average(per.newest),
      },
      equalCount: {
        ranker: {
          recall: mean(equal.ranker.recall),
          precision: nanMeanOf(equal.ranker.precision),
        },
        keyword: {
          recall: mean(equal.keyword.recall),
          precision: nanMeanOf(equal.keyword.precision),
        },
      },
    };
  }
  const scored = Object.entries(results)
    .filter(([, { relevantDays }]) => relevantDays >= MIN_DAYS)
    .map(([id]) => id);
  const recallOf = (profile: string, list: List) =>
    results[profile]?.lists[list].recall ?? Number.NaN;
  const macro = (pick: (result: ProfileResult) => number) =>
    mean(
      scored.map((profile) => {
        const result = results[profile];
        return result === undefined ? Number.NaN : pick(result);
      }),
    );
  const intervals: Record<'keyword' | 'newest', Interval> = {
    keyword: topicBootstrap(
      scored.map(
        (profile) => recallOf(profile, 'ranker') - recallOf(profile, 'keyword'),
      ),
      SEED,
    ),
    newest: topicBootstrap(
      scored.map(
        (profile) => recallOf(profile, 'ranker') - recallOf(profile, 'newest'),
      ),
      SEED,
    ),
  };
  const pass = intervals.keyword.low > -0.05 && intervals.newest.low > 0;
  return {
    scoredProfiles: scored,
    macroRecall: Object.fromEntries(
      LISTS.map((list) => [list, macro((result) => result.lists[list].recall)]),
    ),
    macroSecondary: Object.fromEntries(
      LISTS.map((list) => [
        list,
        {
          precision: macro((result) => result.lists[list].precision),
          emptyDays: macro((result) => result.lists[list].emptyDays),
          missedDays: macro((result) => result.lists[list].missedDays),
        },
      ]),
    ),
    macroEqualCount: {
      ranker: {
        recall: macro((result) => result.equalCount.ranker.recall),
        precision: macro((result) => result.equalCount.ranker.precision),
      },
      keyword: {
        recall: macro((result) => result.equalCount.keyword.recall),
        precision: macro((result) => result.equalCount.keyword.precision),
      },
    },
    intervals,
    pass,
    perProfile: results,
  };
}

function nanMeanOf(values: readonly number[]): number {
  const kept = values.filter((value) => !Number.isNaN(value));
  return kept.length > 0 ? mean(kept) : Number.NaN;
}

// Labels made in memory for a smoke test: for each profile in turn, each
// article draws an integer in [0, 100) from numpy.random.default_rng(9);
// below 6 is relevant, 6 and 7 are ambiguous.
export function randomLabels(
  articles: number,
  profiles: readonly EvalProfile[],
): Record<string, Label>[] {
  const generator = new NumpyGenerator(9);
  const labels = Array.from(
    { length: articles },
    (): Record<string, Label> => ({}),
  );
  for (const { id } of profiles)
    for (const [index, draw] of generator
      .integers(0, 100, articles)
      .entries()) {
      const row = labels[index];
      if (row === undefined) continue;
      if (draw < 6) row[id] = true;
      else if (draw < 8) row[id] = null;
    }
  return labels;
}
