import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import { Collection } from '@zukhruf/embeddings';

import { analyse } from '../src/analyse.ts';
import { DAY_MS } from '../src/day.ts';
import { readMetadata, readSet, sha256 } from './answer-key.ts';
import { changeOfMainScore } from './bootstrap.ts';
import { embeddingModel, vectorCache } from './embedding-model.ts';
import { reportsOf } from './feed.ts';
import { CrossValidation } from './fit/cross-validation.ts';
import { type LoadedSet, foldsOf } from './fit/folds.ts';
import { TRAINING } from './fit/irls.ts';
import type { SelectionRule } from './fit/rule.ts';
import { best } from './fit/selection.ts';
import { Stream } from './fit/stream.ts';
import { mainScore } from './metrics/metrics.ts';
import { type Role } from './roles.ts';
import { partitions, score } from './score.ts';
import { Scoreboard } from './scoreboard.ts';
import { SOURCES } from './texts/sources.ts';

// Builds the design of a research round from its selection rule and the
// training sets alone, with the detector of the package (README.md, "Fit a
// design").
const USAGE = `Usage: nx run event-grouping:fit -- <round>

  round   The folder eval/rounds/<round>. The fit reads its selection-rule.json
          and writes its plan.json.

Environment:
  EVAL_EMBEDDING_URL_<MODEL>  The OpenAI-compatible base URL of the llama.cpp
                              server of each embedding model of the rule.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { help: { type: 'boolean', default: false } },
});
const [round] = positionals;
if (values.help || round === undefined || positionals.length > 1) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}
const started = performance.now();
const folder = join(import.meta.dirname, 'rounds', round);
const ruleBytes = readFileSync(join(folder, 'selection-rule.json'));
const rule: SelectionRule = JSON.parse(ruleBytes.toString('utf8'));
const { recipe } = rule.candidate;
const reference = Scoreboard.read().entries.find(
  (entry) => entry.design === rule.reference.design,
);
if (reference === undefined)
  throw new Error(`The scoreboard has no design ${rule.reference.design}.`);
// The candidate and the reference design, each with its checked model.
const designs = [
  { design: recipe, model: await embeddingModel(recipe, process.env) },
  {
    design: reference.pin.design,
    model: await embeddingModel(reference.pin.design, process.env),
  },
];

const training = await load(rule.data.training, 'training');
const regression = await load(rule.data.regression, 'regression');
const foldsOfSets = foldsOf(rule.folds, training);
// The streams of the folds with the vectors of a design's model.
const streamsOf = ({ design, model }: (typeof designs)[number]) =>
  foldsOfSets.map((fold) =>
    Stream.open(
      fold,
      rule.folds.find((folds) => folds.family === fold.family)!.sets,
      design,
      model,
    ),
  );
const streams = streamsOf(designs[0]!);
const referenceStreams = streamsOf(designs[1]!);

const cv = new CrossValidation(streams, rule.candidate);
const flat = await cv.flat();
const final = best(flat);
const outer = await cv.nested();
const nested = cv.objective(
  new Map(
    outer.map((fold) => {
      const { gold, predicted } = partitions(
        streams.find((stream) => stream.fold.name === fold.fold)!.fold.rows,
        fold.eventOf,
      );
      return [fold.fold, mainScore(gold, predicted)];
    }),
  ),
);
const finalModel = cv.model([]);
const design = cv.design(finalModel, final.threshold);

// The family table of the nested cross-validation: the mean of each score
// over the outer folds of the family.
const outerScores = outer.map((fold) => {
  const { rows, texts } = streams.find(
    (stream) => stream.fold.name === fold.fold,
  )!.fold;
  return { ...fold, score: score(rows, texts, fold.eventOf, []) };
});
const families = Object.fromEntries(
  [...new Set(outer.map((fold) => fold.family))].map((family) => {
    const folds = outerScores.filter((fold) => fold.family === family);
    const mean = (value: (fold: (typeof folds)[number]) => number) =>
      folds.reduce((sum, fold) => sum + value(fold), 0) / folds.length;
    const metric = (name: 'muc' | 'bCubed' | 'ceafE' | 'blanc' | 'pair') =>
      Object.fromEntries(
        (['precision', 'recall', 'f1', 'f05'] as const).map((key) => [
          key,
          mean((fold) => fold.score[name][key]),
        ]),
      );
    return [
      family,
      {
        muc: metric('muc'),
        bCubed: metric('bCubed'),
        ceafE: metric('ceafE'),
        blanc: metric('blanc'),
        pair: metric('pair'),
        conll: {
          f1: mean((fold) => fold.score.conll.f1),
          f05: mean((fold) => fold.score.conll.f05),
        },
        baselines: {
          allSingletons: mean(
            (fold) => fold.score.baselines.allSingletons.conll.f05,
          ),
          allInOne: mean((fold) => fold.score.baselines.allInOne.conll.f05),
        },
        thresholds: folds.map((fold) => fold.threshold),
      },
    ];
  }),
);

// Eligibility against the reference design of the scoreboard.
const referenceScores = await Promise.all(
  referenceStreams
    .filter((stream) => stream.fold.family === rule.reference.family)
    .map(async (stream) => {
      const { gold, predicted } = partitions(
        stream.fold.rows,
        await stream.run(reference.pin.design),
      );
      return mainScore(gold, predicted);
    }),
);
const referenceFamily =
  referenceScores.reduce((sum, value) => sum + value, 0) /
  referenceScores.length;
const checks = Object.fromEntries(
  await Promise.all(
    [...regression.values()].map(async (set) => {
      const fold = { ...set, family: 'regression' };
      using stream = Stream.open(
        fold,
        [set.name],
        designs[0]!.design,
        designs[0]!.model,
      );
      using referenceStream = Stream.open(
        fold,
        [set.name],
        designs[1]!.design,
        designs[1]!.model,
      );
      const eventOf = await stream.run(design);
      const interval = changeOfMainScore(
        set.rows,
        eventOf,
        await referenceStream.run(reference.pin.design),
      );
      return [
        set.name,
        {
          conllF05: score(set.rows, set.texts, eventOf, []).conll.f05,
          interval,
          notEntirelyBelow0: interval.high >= 0,
        },
      ] as const;
    }),
  ),
);
const E1 = Object.values(families).every(
  (family) =>
    family.conll.f05 >
    Math.max(family.baselines.allSingletons, family.baselines.allInOne),
);
const E2 = families[rule.reference.family]!.conll.f05 > referenceFamily;
const E3 = Object.values(checks).every((check) => check.notEntirelyBelow0);

const { planSha256: _, ...fitted } = design;
writeFileSync(
  join(folder, 'plan.json'),
  `${JSON.stringify(
    {
      round,
      candidate: rule.candidate.name,
      hashes: {
        'selection-rule.json': sha256(ruleBytes),
        labels: Object.fromEntries(
          [...training.keys(), ...regression.keys()].map((name) => [
            name,
            readMetadata(name).labelsSha256,
          ]),
        ),
      },
      design: fitted,
      training: {
        ...TRAINING,
        rows: finalModel.rows,
        positives: finalModel.positives,
        iterations: finalModel.iterations,
        pairs: `batch shortlist pairs (top ${recipe.shortlistSize} within ${recipe.windowDays} days) of all ${streams.length} training folds`,
      },
      crossValidation: {
        objective: nested,
        families,
        outer: outer.map(({ fold, family, threshold, innerObjective }) => ({
          fold,
          family,
          threshold,
          innerObjective,
        })),
        flat: { curve: flat, final },
      },
      eligibility: {
        reference: rule.reference.design,
        referenceFamily: { [rule.reference.family]: referenceFamily },
        regression: checks,
        E1,
        E2,
        E3,
        eligible: E1 && E2 && E3,
      },
    },
    null,
    2,
  )}\n`,
);
for (const stream of [...streams, ...referenceStreams])
  stream[Symbol.dispose]();
console.log(
  `Round ${round}: threshold ${final.threshold}, nested objective ${nested.toFixed(4)}, eligible ${E1 && E2 && E3} (${Math.round((performance.now() - started) / 1000)} s). Wrote eval/rounds/${round}/plan.json.`,
);

// The sets of one role, with their texts. The role in set.json is read
// before the answer key, so the fit never opens a set of another role. Each
// lead of each design goes into the vector cache of its model for the set, as
// the runner puts it there.
async function load(
  names: readonly string[],
  role: Role,
): Promise<Map<string, LoadedSet>> {
  const sets = new Map<string, LoadedSet>();
  for (const name of names) {
    const metadata = readMetadata(name);
    if (metadata.role !== role)
      throw new Error(
        `${name} has the role ${metadata.role}, and the rule names it a ${role} set. The fit refuses it.`,
      );
    const set = readSet(name);
    const { texts, vanished, changed } = await SOURCES[metadata.text].texts(
      set,
      false,
    );
    if (vanished.length > 0 || changed.length > 0)
      console.log(
        `${name}: ${vanished.length} vanished and ${changed.length} changed texts.`,
      );
    for (const { design, model } of designs) {
      using cache = new DatabaseSync(vectorCache(design.embeddingModel, name));
      await new Collection({ database: cache, model }).upsert(
        reportsOf(set.rows, texts).flatMap((report) => {
          const { text, day } = analyse(report, design);
          return text === null
            ? []
            : [{ id: report.id, text, publishedAt: new Date(day * DAY_MS) }];
        }),
      );
    }
    sets.set(name, { name, rows: set.rows, texts });
  }
  return sets;
}
