import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { EVAL_FOLDER, SETS_FOLDER, readMetadata } from './answer-key.ts';
import {
  type Interval,
  articleBootstrap,
  articleWeights,
  topicBootstrap,
  weightedF05,
} from './bootstrap.ts';
import { descriptionVectors } from './cache.ts';
import { implementationCheck } from './check.ts';
import { joined } from './design.ts';
import { mean, nanMean } from './metrics.ts';
import { type EvalProfile, readProfiles } from './profiles.ts';
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
const USAGE = `Usage: nx run relevance-filtering:eval -- [check | slices | rehearse | --exam]

  check     The implementation check: the package against the frozen record.
  slices    Round 6 again: product teaching on the fresh slices (default).
  rehearse  The exam protocol with fresh-2 as the stream and the collection
            and fresh as the teaching pool. It gives no verdict.
  --exam    Score the sealed exam one time, with the verdict rule of
            freeze/plan.json. It needs a passing implementation check.`;

const RESULTS_FOLDER = join(EVAL_FOLDER, 'results');
const CELLS = [5, 10] as const;
const SLICES = ['fresh', 'fresh-2'] as const;
const POOL = ['collection', 'fresh', 'fresh-2'] as const;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    exam: { type: 'boolean', default: false },
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
if (command === 'check') process.exit(passed && exact ? 0 : 1);

if (values.exam) {
  if (!passed || !exact)
    throw new Error('The exam needs a passing implementation check.');
  exam();
} else if (command === 'rehearse') {
  const result = examProtocol('fresh-2', ['collection', 'fresh']);
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

// The one score of the sealed exam (freeze/plan.json, examVerdictRule).
function exam(): void {
  const decision = decide(readMetadata('exam'), true);
  if (!decision.run || decision.role !== 'exam')
    throw new Error('The exam set is not an exam that was never scored.');
  const firstScoredAt = new Date().toISOString();
  const result = { firstScoredAt, ...examProtocol('exam', POOL) };
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

// The exam protocol: product teaching from the pool, the design and the
// baselines on the stream, and the verdict with the label-stratified article
// bootstrap.
function examProtocol(streamName: string, poolNames: readonly string[]) {
  using examSet = new LoadedSet(streamName);
  using stack = new DisposableStack();
  const pool = poolNames.map((name) => stack.use(new LoadedSet(name)));
  const vectors = joined(
    examSet.collection,
    pool.map(({ collection }) => collection),
  );
  const runs: Record<string, Record<number, Unit>> = {};
  for (const profile of profiles) {
    const descriptionVector = descriptionOf(profile);
    const candidates: Candidate[] = pool.flatMap((set) => {
      const similarities = set.similarities(descriptionVector);
      const narrow = set.matches(profile.narrow);
      const labels = set.labelsFor(profile.id);
      return set.articles.map(({ id }, index) => ({
        id,
        similarity: similarities[index] ?? Number.NaN,
        match: narrow[index] ?? false,
        label: labels[index],
      }));
    });
    const narrow = examSet.matches(profile.narrow);
    const broad = examSet.matches(profile.broad);
    const labels = examSet.labelsFor(profile.id);
    const [first, ...rest] = examSet.articles.map((article, index) => ({
      ...article,
      text: examSet.textOf(article.id),
      label: labels[index],
      narrow: narrow[index] ?? false,
      broad: broad[index] ?? false,
    }));
    if (first === undefined) throw new Error('The exam has no article.');
    for (const n of CELLS)
      (runs[profile.id] ??= {})[n] = runUnit({
        profile,
        pool: candidates,
        n,
        stream: [first, ...rest],
        vectors,
        descriptionVector,
        textOf: (id) =>
          [examSet, ...pool].find(({ texts }) => texts.has(id))?.textOf(id) ??
          examSet.textOf(id),
      });
  }
  const labelsOf = (profile: string) => examSet.labelsFor(profile);
  const verdictProfiles = profiles
    .map(({ id }) => id)
    .filter(
      (id) =>
        id !== 'biology' &&
        labelsOf(id).filter((label) => label === true).length >= 3,
    );
  const unitsOf = (profile: string) => Object.values(runs[profile] ?? {});
  const point = (profile: string, name: Name) =>
    mean(unitsOf(profile).map(({ rows }) => rows[name].strict.f05));
  const macro = (name: Name) =>
    mean(verdictProfiles.map((profile) => point(profile, name)));
  const skill = mean(
    verdictProfiles.map((profile) =>
      nanMean(
        unitsOf(profile).map(({ rows }) => rows[DESIGN].strict.brierSkill),
      ),
    ),
  );
  const relevantToAny = examSet.articles.map((_, index) =>
    verdictProfiles.some((profile) => labelsOf(profile)[index] === true),
  );
  const weights = articleWeights(relevantToAny, 31958);
  const weightedMacro = (name: Name, replicate: readonly number[]) =>
    mean(
      verdictProfiles.map((profile) => {
        const labels = labelsOf(profile);
        return mean(
          unitsOf(profile).map((unit) =>
            weightedF05(
              {
                accepted: unit.accepted[name],
                relevant: labels.map((label) => label === true),
                ambiguous: labels.map((label) => label === null),
              },
              replicate,
            ),
          ),
        );
      }),
    );
  const intervals: Record<string, Interval> = Object.fromEntries(
    BASELINES.map((baseline) => [
      baseline,
      articleBootstrap(
        weights,
        macro(DESIGN) - macro(baseline),
        (replicate) =>
          weightedMacro(DESIGN, replicate) - weightedMacro(baseline, replicate),
      ),
    ]),
  );
  return {
    stream: streamName,
    pool: poolNames,
    profiles: verdictProfiles,
    macroF05: byName(macro),
    macroBrierSkill: skill,
    verdict: verdict({ intervals, macroBrierSkill: skill }),
    biology: byName((name) => point('biology', name)),
    runs,
  };
}
