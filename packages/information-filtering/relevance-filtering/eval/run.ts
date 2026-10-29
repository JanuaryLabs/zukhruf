import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  EVAL_FOLDER,
  SETS_FOLDER,
  readArticles,
  readMetadata,
} from './answer-key.ts';
import {
  type Interval,
  articleBootstrap,
  articleWeights,
  topicBootstrap,
} from './bootstrap.ts';
import { descriptionVectors } from './cache.ts';
import { implementationCheck } from './check.ts';
import { daily, randomLabels } from './daily.ts';
import { joined } from './design.ts';
import { mean, nanMean } from './metrics.ts';
import { type EvalProfile, readProfiles } from './profiles.ts';
import { rankingCheck } from './ranking-check.ts';
import {
  RANKER,
  RANKING_BASELINES,
  type RankName,
  type RankingUnit,
  averagePrecision,
  byRank,
  poolOf,
  runRankingUnit,
  streamOf,
} from './ranking.ts';
import { decide } from './roles.ts';
import {
  BASELINES,
  DESIGN,
  type Name,
  type Unit,
  byName,
  runUnit,
} from './runs.ts';
import { LoadedSet } from './slice.ts';
import type { Candidate } from './teaching.ts';
import { scoredStream, windowOf } from './units.ts';
import { verdict } from './verdict.ts';

// Runs the frozen design through the package on the labelled sets
// (README.md).
const USAGE = `Usage: nx run relevance-filtering:eval -- [check | slices | ranking | rehearse | --exam]

  check     The implementation checks: the decisions of freeze/plan.json and
            the ranking of freeze-ranking/plan.json.
  slices    Round 6 again: yes/no decisions on the fresh slices (default).
  ranking   Round 10 again: MAP of the ranking in the window and pool
            protocols on fresh-3.
  daily [set] [--smoke]
            Round 11: the best-N-a-day list against the keyword list on the
            test slice (default fresh-4), teaching from every other labelled
            slice. --smoke gives the test slice random labels in memory and
            never reads its label files.
  rehearse  The ranking exam protocol with fresh-3 as the stream and the
            collection, fresh and fresh-2 as the teaching pool. It gives no
            verdict and reads no exam label.
  --exam    Score the sealed exam one time, with the ranking verdict rule of
            freeze-ranking/plan.json. It needs a passing ranking check.`;

const RESULTS_FOLDER = join(EVAL_FOLDER, 'results');
const CELLS = [5, 10] as const;
const SLICES = ['fresh', 'fresh-2'] as const;
const EXAM_POOL = ['collection', 'fresh', 'fresh-2', 'fresh-3'] as const;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    exam: { type: 'boolean', default: false },
    smoke: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const [command = 'slices'] = positionals;
mkdirSync(RESULTS_FOLDER, { recursive: true });
const profiles = readProfiles();
const descriptions = descriptionVectors();
const descriptionOf = (profile: EvalProfile) => {
  const vector = descriptions.get(profile.id);
  if (vector === undefined)
    throw new Error(`The cache has no description vector of ${profile.id}.`);
  return vector;
};

const checks = implementationCheck();
for (const check of checks) console.log(JSON.stringify(check));
const passed = checks.every(
  (check) =>
    check.sameShown &&
    check.sameTaught &&
    check.sameDecisions &&
    check.accepted.expected === check.accepted.actual,
);
const reference = checks.find(({ file }) => file === 'float32-reference.json');
const exact =
  reference !== undefined &&
  Math.max(...Object.values(reference.maxDifference)) <= 1e-9;
console.log(
  passed && exact
    ? 'Implementation check: the package gives the decisions of the record, and the probabilities of the research code on stored vectors to 1e-9.'
    : 'Implementation check: FAILED.',
);
const ranking = rankingCheck();
console.log(JSON.stringify(ranking));
const rankingPassed = ranking.float32.same && ranking.float64.same;
console.log(
  rankingPassed
    ? `Ranking check: the package gives the order of round 10 for all ${ranking.articles} articles.`
    : 'Ranking check: FAILED.',
);
if (command === 'check') process.exit(passed && exact && rankingPassed ? 0 : 1);

if (values.exam) {
  if (!rankingPassed)
    throw new Error('The exam needs a passing ranking check.');
  exam();
} else if (command === 'ranking') rankingRounds();
else if (command === 'daily') dailyRound();
else if (command === 'rehearse') {
  const result = examProtocol('fresh-3', ['collection', 'fresh', 'fresh-2']);
  writeFileSync(
    join(RESULTS_FOLDER, 'rehearsal.json'),
    JSON.stringify(result, null, 1),
  );
  console.log(JSON.stringify({ ...result, runs: undefined }, null, 1));
} else slices();

// Round 6 on the fresh slices: each slice teaches from its first 14 days and
// decides on the rest.
function slices(): void {
  const units: Record<string, Record<string, Unit>> = {};
  for (const name of SLICES) {
    using slice = new LoadedSet(name);
    const window = windowOf(slice);
    const stream = scoredStream(slice, window);
    for (const profile of profiles) {
      const descriptionVector = descriptionOf(profile);
      const similarities = slice.similarities(descriptionVector);
      const narrow = slice.matches(profile.narrow);
      const broad = slice.matches(profile.broad);
      const labels = slice.labelsFor(profile.id);
      const pool: Candidate[] = [];
      const articles = [];
      for (const [index, article] of slice.articles.entries()) {
        if (window[index])
          pool.push({
            id: article.id,
            similarity: similarities[index] ?? Number.NaN,
            match: narrow[index] ?? false,
            label: labels[index],
          });
        else
          articles.push({
            ...article,
            text: slice.textOf(article.id),
            label: labels[index],
            narrow: narrow[index] ?? false,
            broad: broad[index] ?? false,
          });
      }
      const [first, ...rest] = articles;
      if (first === undefined || stream.length !== articles.length)
        throw new Error(`${name} has no stream.`);
      for (const n of CELLS)
        (units[profile.id] ??= {})[`${name}|${n}`] = runUnit({
          profile,
          pool,
          n,
          stream: [first, ...rest],
          vectors: slice.collection,
          descriptionVector,
          textOf: slice.textOf,
        });
    }
  }
  const perProfile: Record<string, Record<Name, number>> = {};
  const skill: Record<string, number> = {};
  for (const [profile, byUnit] of Object.entries(units)) {
    const used = Object.values(byUnit).filter(
      ({ scoredRelevant }) => scoredRelevant >= 15,
    );
    if (used.length === 0) continue;
    perProfile[profile] = byName((name) =>
      mean(used.map(({ rows }) => rows[name].strict.f05)),
    );
    skill[profile] = nanMean(
      used.map(({ rows }) => rows[DESIGN].strict.brierSkill),
    );
  }
  const scored = Object.keys(perProfile);
  const macro = (name: Name) =>
    mean(scored.map((profile) => perProfile[profile]?.[name] ?? Number.NaN));
  const intervals = Object.fromEntries(
    BASELINES.map((baseline) => [
      baseline,
      topicBootstrap(
        scored.map(
          (profile) =>
            (perProfile[profile]?.[DESIGN] ?? Number.NaN) -
            (perProfile[profile]?.[baseline] ?? Number.NaN),
        ),
        31957,
      ),
    ]),
  );
  const result = {
    scoredProfiles: scored,
    macroF05: byName(macro),
    macroBrierSkill: mean(Object.values(skill)),
    intervalsVsBaselines: intervals,
    nonInferiorMargin005: (intervals.keywordNarrow?.low ?? -1) > -0.05,
    perProfileF05: perProfile,
    units,
  };
  writeFileSync(
    join(RESULTS_FOLDER, 'slices.json'),
    JSON.stringify(result, null, 1),
  );
  console.log(
    JSON.stringify(
      {
        scoredProfiles: scored,
        macroF05: result.macroF05,
        macroBrierSkill: result.macroBrierSkill,
        intervalsVsBaselines: intervals,
        nonInferiorMargin005: result.nonInferiorMargin005,
      },
      null,
      1,
    ),
  );
}

// Round 10 on fresh-3: the window protocol teaches from its first 14 days
// and ranks the rest; the pool protocol teaches from the collection, fresh
// and fresh-2 and ranks all of fresh-3.
function rankingRounds(): void {
  using stack = new DisposableStack();
  const slice = stack.use(new LoadedSet('fresh-3'));
  const earlier = ['collection', 'fresh', 'fresh-2'].map((name) =>
    stack.use(new LoadedSet(name)),
  );
  const window = windowOf(slice);
  const vectors = joined(
    slice.collection,
    earlier.map(({ collection }) => collection),
  );
  const textOf = (id: string) =>
    [slice, ...earlier].find(({ texts }) => texts.has(id))?.textOf(id) ?? '';
  const protocols = {
    window: (profile: EvalProfile, d: readonly number[]) => ({
      pool: poolOf([slice], profile, d, (_, index) => window[index] ?? false),
      stream: streamOf(slice, profile, (index) => !window[index]),
    }),
    pool: (profile: EvalProfile, d: readonly number[]) => ({
      pool: poolOf(earlier, profile, d),
      stream: streamOf(slice, profile),
    }),
  };
  const result = Object.fromEntries(
    Object.entries(protocols).map(([name, parts]) => {
      const units: Record<string, RankingUnit[]> = {};
      for (const profile of profiles) {
        const descriptionVector = descriptionOf(profile);
        const { pool, stream } = parts(profile, descriptionVector);
        units[profile.id] = CELLS.map((n) =>
          runRankingUnit({
            profile,
            pool,
            n,
            stream,
            vectors,
            descriptionVector,
            textOf,
          }),
        );
      }
      const perProfile: Record<string, Record<RankName, number>> = {};
      for (const [profile, list] of Object.entries(units)) {
        const used = list.filter(({ scoredRelevant }) => scoredRelevant >= 15);
        if (used.length > 0)
          perProfile[profile] = byRank((rank) =>
            mean(used.map(({ ap }) => ap[rank])),
          );
      }
      const scored = Object.keys(perProfile);
      const intervals = Object.fromEntries(
        RANKING_BASELINES.map((baseline) => [
          baseline,
          topicBootstrap(
            scored.map(
              (profile) =>
                (perProfile[profile]?.[RANKER] ?? Number.NaN) -
                (perProfile[profile]?.[baseline] ?? Number.NaN),
            ),
            31962,
          ),
        ]),
      );
      return [
        name,
        {
          scoredProfiles: scored,
          MAP: byRank((rank) =>
            mean(
              scored.map(
                (profile) => perProfile[profile]?.[rank] ?? Number.NaN,
              ),
            ),
          ),
          intervals,
          pass: verdict(intervals).result === 'pass',
          perProfileAP: perProfile,
        },
      ];
    }),
  );
  writeFileSync(
    join(RESULTS_FOLDER, 'ranking.json'),
    JSON.stringify(result, null, 1),
  );
  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(result).map(([name, { perProfileAP: _, ...rest }]) => [
          name,
          rest,
        ]),
      ),
      null,
      1,
    ),
  );
}

// The one score of the sealed exam (freeze-ranking/plan.json,
// examVerdictRule).
function exam(): void {
  const decision = decide(readMetadata('exam'), true);
  if (!decision.run || decision.role !== 'exam')
    throw new Error('The exam set is not an exam that was never scored.');
  const firstScoredAt = new Date().toISOString();
  const result = { firstScoredAt, ...examProtocol('exam', EXAM_POOL) };
  writeFileSync(
    join(RESULTS_FOLDER, 'exam.json'),
    JSON.stringify(result, null, 1),
  );
  const file = join(SETS_FOLDER, 'exam', 'set.json');
  writeFileSync(
    file,
    `${JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), firstScoredAt }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ ...result, runs: undefined }, null, 1));
}

// The ranking exam protocol: product teaching from the whole pool, the
// ranking and the baselines on the stream, MAP over the profiles with at
// least 3 strict relevant stream articles, and the paired two-strata
// article bootstrap (seed 31963).
function examProtocol(streamName: string, poolNames: readonly string[]) {
  using stack = new DisposableStack();
  const streamSet = stack.use(new LoadedSet(streamName));
  const pool = poolNames.map((name) => stack.use(new LoadedSet(name)));
  const vectors = joined(
    streamSet.collection,
    pool.map(({ collection }) => collection),
  );
  const textOf = (id: string) =>
    [streamSet, ...pool].find(({ texts }) => texts.has(id))?.textOf(id) ?? '';
  const labelsOf = (profile: string) =>
    new Map(
      streamSet.articles.map(({ id }, index) => [
        id,
        streamSet.labelsFor(profile)[index],
      ]),
    );
  const verdictProfiles = profiles.filter(
    ({ id }) =>
      streamSet.labelsFor(id).filter((label) => label === true).length >= 3,
  );
  const runs: Record<string, RankingUnit[]> = {};
  for (const profile of verdictProfiles) {
    const descriptionVector = descriptionOf(profile);
    const candidates = poolOf(pool, profile, descriptionVector);
    const stream = streamOf(streamSet, profile);
    runs[profile.id] = CELLS.map((n) =>
      runRankingUnit({
        profile,
        pool: candidates,
        n,
        stream,
        vectors,
        descriptionVector,
        textOf,
      }),
    );
  }
  const ids = verdictProfiles.map(({ id }) => id);
  const labels = new Map(ids.map((id) => [id, labelsOf(id)]));
  // The MAP of a list: AP per profile with the weights of a replicate, mean
  // over N, mean over the profiles. A profile whose relevant articles a
  // replicate does not draw has no AP, and is left out of that replicate.
  const map = (name: RankName, weights?: ReadonlyMap<string, number>) =>
    nanMean(
      ids.map((profile) =>
        nanMean(
          (runs[profile] ?? []).map(({ orders }) =>
            averagePrecision(
              orders[name],
              labels.get(profile) ?? new Map(),
              weights,
            ),
          ),
        ),
      ),
    );
  const relevantToAny = streamSet.articles.map(({ id }) =>
    ids.some((profile) => labels.get(profile)?.get(id) === true),
  );
  const weights = articleWeights(relevantToAny, 31963);
  const intervals: Record<string, Interval> = Object.fromEntries(
    RANKING_BASELINES.map((baseline) => [
      baseline,
      articleBootstrap(weights, map(RANKER) - map(baseline), (row) => {
        const replicate = new Map(
          streamSet.articles.map(({ id }, index) => [id, row[index] ?? 0]),
        );
        return map(RANKER, replicate) - map(baseline, replicate);
      }),
    ]),
  );
  return {
    stream: streamName,
    pool: poolNames,
    profiles: ids,
    MAP: byRank((name) => map(name)),
    verdict: verdict(intervals),
    perProfileAP: Object.fromEntries(
      ids.map((profile) => [
        profile,
        byRank((name) =>
          nanMean((runs[profile] ?? []).map(({ ap }) => ap[name])),
        ),
      ]),
    ),
    runs,
  };
}

// Round 11 (#3308): the lists of each day on the test slice.
function dailyRound(): void {
  const testName = positionals[1] ?? 'fresh-4';
  const poolNames = ['collection', 'fresh', 'fresh-2', 'fresh-3'].filter(
    (name) => name !== testName,
  );
  using stack = new DisposableStack();
  const test = stack.use(
    new LoadedSet(
      testName,
      values.smoke
        ? randomLabels(readArticles(testName).length, profiles)
        : undefined,
    ),
  );
  const pool = poolNames.map((name) => stack.use(new LoadedSet(name)));
  const result = {
    test: testName,
    smoke: values.smoke,
    pool: poolNames,
    ...daily({ profiles, descriptionOf, test, pool }),
  };
  writeFileSync(
    join(
      RESULTS_FOLDER,
      values.smoke ? `daily-smoke-${testName}.json` : `daily-${testName}.json`,
    ),
    JSON.stringify(result, null, 1),
  );
  console.log(JSON.stringify({ ...result, perProfile: undefined }, null, 1));
}
