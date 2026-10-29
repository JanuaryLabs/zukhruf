import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import type { EmbeddingModel } from 'ai';

import { Collection } from '@zukhruf/embeddings';

import { DAY_MS } from '../src/day.ts';
import type { Design } from '../src/index.ts';
import { readMetadata, readSet, sha256 } from './answer-key.ts';
import { changeOfMainScore } from './bootstrap.ts';
import { embeddingModel, vectorCache } from './embedding-model.ts';
import { reportsOf } from './feed.ts';
import { analysedAsFed } from './fit/analysed.ts';
import { type Evaluation, evaluate } from './fit/candidate.ts';
import { type Fold, type LoadedSet, foldsOf } from './fit/folds.ts';
import type { SelectionRule } from './fit/rule.ts';
import { crossValidatedChange } from './fit/selection.ts';
import { Stream } from './fit/stream.ts';
import { mainScore } from './metrics/metrics.ts';
import type { Role } from './roles.ts';
import { partitions, score } from './score.ts';
import { Scoreboard } from './scoreboard.ts';
import { SOURCES } from './texts/sources.ts';

// Builds the designs of a research round from its selection rule and the
// training sets alone, with the detector of the package, and applies the
// choice of the rule (README.md, "Fit a design").
const USAGE = `Usage: nx run event-grouping:fit -- <round>

  round   The folder eval/rounds/<round>. The fit reads its selection-rule.json
          and writes its plan.json.

Environment:
  EVAL_EMBEDDING_URL_<MODEL>  The OpenAI-compatible base URL of the llama.cpp
                              server of each embedding model of the rule.`;

type VectorDesign = Pick<Design, 'embeddingModel' | 'lead' | 'vectorText'>;

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
const entry = Scoreboard.read().entries.find(
  (candidate) => candidate.design === rule.reference.design,
);
if (entry === undefined)
  throw new Error(`The scoreboard has no design ${rule.reference.design}.`);
const reference = entry.pin.design;

// The checked model of each embedding model of the rule.
const models = new Map<string, Exclude<EmbeddingModel, string>>();
for (const design of [
  ...rule.candidates.map((candidate) => candidate.recipe),
  reference,
])
  if (!models.has(design.embeddingModel))
    models.set(
      design.embeddingModel,
      await embeddingModel(design, process.env),
    );
const modelOf = (design: VectorDesign) => models.get(design.embeddingModel)!;

const training = await load(rule.data.training, 'training');
const regression = await load(rule.data.regression, 'regression');
const folds = foldsOf(rule.folds, training);
const setsOf = (fold: Fold) =>
  rule.folds.find((folds) => folds.family === fold.family)!.sets;
// The streams of the folds with the vectors of a design.
const streamsOf = (design: VectorDesign) =>
  folds.map((fold) => Stream.open(fold, setsOf(fold), design, modelOf(design)));
// The events of a design on each regression set.
async function regressionEvents(
  design: Design,
): Promise<Map<string, ReadonlyMap<string, string>>> {
  const events = new Map<string, ReadonlyMap<string, string>>();
  for (const set of regression.values()) {
    using stream = Stream.open(
      { ...set, family: 'regression' },
      [set.name],
      design,
      modelOf(design),
    );
    events.set(set.name, await stream.run(design));
  }
  return events;
}

const referenceEvents = await regressionEvents(reference);
const evaluations: Evaluation[] = [];
const records: Record<string, Record<string, unknown>> = {};
const eligible = new Map<string, boolean>();
for (const candidate of rule.candidates) {
  const streams = streamsOf(candidate.recipe);
  const evaluation = await evaluate(candidate, streams);
  for (const stream of streams) stream[Symbol.dispose]();
  evaluations.push(evaluation);
  console.log(
    `${candidate.name}: nested objective ${evaluation.objective.toFixed(4)}, threshold ${evaluation.design.threshold} (${Math.round((performance.now() - started) / 1000)} s)`,
  );
}

// E2 compares with the reference design as it is, or with the nested-CV
// score of a candidate.
const { family } = rule.e2;
const e2Score =
  rule.e2.against === 'reference'
    ? await referenceScore(family)
    : byName(rule.e2.against.candidate).families[family]!.conll.f05;
for (const evaluation of evaluations) {
  const events = await regressionEvents(evaluation.design);
  const checks = Object.fromEntries(
    [...regression.values()].map((set) => {
      const eventOf = events.get(set.name)!;
      const interval = changeOfMainScore(
        set.rows,
        eventOf,
        referenceEvents.get(set.name)!,
      );
      return [
        set.name,
        {
          conllF05: score(set.rows, set.texts, eventOf, []).conll.f05,
          interval,
          notEntirelyBelow0: interval.high >= 0,
        },
      ];
    }),
  );
  const E1 = Object.values(evaluation.families).every(
    (scores) =>
      scores.conll.f05 >
      Math.max(scores.baselines.allSingletons, scores.baselines.allInOne),
  );
  const E2 = evaluation.families[family]!.conll.f05 > e2Score;
  const E3 = Object.values(checks).every((check) => check.notEntirelyBelow0);
  eligible.set(evaluation.candidate.name, E1 && E2 && E3);
  records[evaluation.candidate.name] = {
    ...evaluation.record,
    eligibility: {
      reference: rule.reference.design,
      e2: { family, against: rule.e2.against, score: e2Score },
      regression: checks,
      E1,
      E2,
      E3,
      eligible: E1 && E2 && E3,
    },
  };
}

const choice = choose();
writeFileSync(
  join(folder, 'plan.json'),
  `${JSON.stringify(
    {
      round,
      hashes: {
        'selection-rule.json': sha256(ruleBytes),
        labels: Object.fromEntries(
          [...training.keys(), ...regression.keys()].map((name) => [
            name,
            readMetadata(name).labelsSha256,
          ]),
        ),
      },
      candidates: records,
      choice,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Round ${round}: chosen ${choice.chosen ?? 'none'} (${Math.round((performance.now() - started) / 1000)} s). Wrote eval/rounds/${round}/plan.json.`,
);

// The choice of the rule: the one eligible candidate, or the best eligible
// challenger whose gain over the incumbent is above 0.
function choose(): {
  chosen: string | null;
  comparison?: Record<string, unknown>;
} {
  if (rule.choice === undefined) {
    const [only] = rule.candidates;
    return {
      chosen: only !== undefined && eligible.get(only.name) ? only.name : null,
    };
  }
  const incumbent = byName(rule.choice.incumbent);
  const challenger = rule.choice.challengers
    .map(byName)
    .filter((evaluation) => eligible.get(evaluation.candidate.name))
    .toSorted((a, b) => b.objective - a.objective)[0];
  if (challenger === undefined) return { chosen: null };
  const interval = crossValidatedChange({
    folds: folds.map((fold) => ({
      name: fold.name,
      family: fold.family,
      gold: new Map(fold.rows.map((row) => [row.id, row.event])),
    })),
    challenger: challenger.outer,
    incumbent: incumbent.outer,
  });
  return {
    chosen: interval.low > 0 ? challenger.candidate.name : null,
    comparison: {
      challenger: challenger.candidate.name,
      incumbent: incumbent.candidate.name,
      interval,
    },
  };
}

function byName(name: string): Evaluation {
  const evaluation = evaluations.find(
    (candidate) => candidate.candidate.name === name,
  );
  if (evaluation === undefined)
    throw new Error(`The rule has no candidate ${name}.`);
  return evaluation;
}

// The mean main score of the reference design as it is on the folds of a
// family.
async function referenceScore(name: string): Promise<number> {
  const scores: number[] = [];
  for (const fold of folds.filter((fold) => fold.family === name)) {
    using stream = Stream.open(
      fold,
      setsOf(fold),
      reference,
      modelOf(reference),
    );
    const { gold, predicted } = partitions(
      fold.rows,
      await stream.run(reference),
    );
    scores.push(mainScore(gold, predicted));
  }
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

// The sets of one role, with their texts. The role in set.json is read
// before the answer key, so the fit never opens a set of another role. Each
// lead of each design goes into the vector cache of the design for the set,
// as the runner puts it there.
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
    for (const design of [
      ...rule.candidates.map((candidate) => candidate.recipe),
      reference,
    ]) {
      using cache = new DatabaseSync(vectorCache(design, name));
      await new Collection({ database: cache, model: modelOf(design) }).upsert(
        [...analysedAsFed(reportsOf(set.rows, texts), design).values()].flatMap(
          ({ id, text, day }) =>
            text === null
              ? []
              : [{ id, text, publishedAt: new Date(day * DAY_MS) }],
        ),
      );
    }
    sets.set(name, { name, rows: set.rows, texts });
  }
  return sets;
}
