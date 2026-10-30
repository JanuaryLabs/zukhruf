import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import { Collection } from '@zukhruf/embeddings';

import { type Design, design3152b } from '../src/index.ts';
import { readEvents, writeEvents } from './accepted.ts';
import { type EvalSet, readMetadata, readSet, setNames } from './answer-key.ts';
import { type Interval, changeOfMainScore } from './bootstrap.ts';
import { embeddingModel, vectorCache } from './embedding-model.ts';
import { feed } from './feed.ts';
import type { Partition } from './metrics/contingency.ts';
import type { Score } from './metrics/f-measure.ts';
import { METRICS_VERSION } from './metrics/metrics.ts';
import { committed, currentPin } from './pin.ts';
import { decide } from './roles.ts';
import { type SetScore, score } from './score.ts';
import { type Entry, Scoreboard, type SetEntry } from './scoreboard.ts';
import { SOURCES } from './texts/sources.ts';
import { verdict } from './verdict.ts';

// Runs a design of the package on the evaluation sets, and compares each
// score with the latest accepted design (README.md).
const USAGE = `Usage: nx run event-detection:eval -- [set ...] [--refresh] [--exam] [--accept <design>]

  set               The sets to score. All sets when none is given.
  --refresh         Get each text from its source again, not from the cache.
  --exam            Also score the exam sets that were never scored.
  --accept <design> Record the scores as an accepted design in scoreboard.json.

Environment:
  EVAL_EMBEDDING_URL_<MODEL>  The OpenAI-compatible base URL of the llama.cpp
                              server of each embedding model that the run uses,
                              for example EVAL_EMBEDDING_URL_EMBEDDINGGEMMA_2.`;

// The design that this run scores.
const DESIGN = design3152b;

const RESULTS_FOLDER = join(import.meta.dirname, 'results');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    refresh: { type: 'boolean', default: false },
    exam: { type: 'boolean', default: false },
    accept: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (values.accept !== undefined && positionals.length > 0)
  throw new Error('--accept records a design on every set: name no set.');
if (values.exam && positionals.length > 0)
  throw new Error(
    '--exam gives a verdict that needs every regression set in the same run: name no set.',
  );

const scoreboard = Scoreboard.read();
const pin = currentPin(DESIGN);
if (values.accept !== undefined) {
  if (!committed())
    throw new Error(
      `--accept pins the design to commit ${pin.commit}, but src/ has changes that are not committed. Commit the design first.`,
    );
  // Refuses a name that the scoreboard has, before the run.
  scoreboard.with({ ...draft(values.accept), sets: {} });
}
const holds = scoreboard.designOf(DESIGN);
console.log(
  holds === null
    ? `Design ${DESIGN.name} is not accepted.`
    : `Design ${DESIGN.name} is accepted as ${holds.design} (pinned to commit ${holds.pin.commit}).`,
);

// The model of each design that the run uses, checked against its probe once.
const models = new Map<string, ReturnType<typeof embeddingModel>>();
function modelOf(design: Design): ReturnType<typeof embeddingModel> {
  let model = models.get(design.embeddingModel);
  if (model === undefined) {
    model = embeddingModel(design, process.env);
    models.set(design.embeddingModel, model);
  }
  return model;
}
await modelOf(DESIGN);

const accepted: Record<string, SetEntry> = {};
const events: { set: EvalSet; eventOf: Partition }[] = [];
const refusals: string[] = [];
const regressionSets: Record<string, Interval> = {};
// The exam sets of this run, scored for the first time.
const exams: {
  file: string;
  payload: Record<string, unknown>;
  mainScore: number;
  baselines: number[];
  change: Interval;
}[] = [];
for (const name of positionals.length > 0 ? positionals : setNames()) {
  const decision = decide(readMetadata(name), values.exam);
  if (!decision.run) {
    console.log(`\n${name}: skipped. ${decision.reason}`);
    continue;
  }
  const set = readSet(name);
  const texts = await SOURCES[set.metadata.text].texts(set, values.refresh);
  using caches = new DisposableStack();
  // The vectors of a design: the cache of its model for the set.
  const vectorsOf = async (design: Design) =>
    new Collection({
      database: caches.use(new DatabaseSync(vectorCache(design, name))),
      model: await modelOf(design),
    });
  const fed = await feed(
    set.rows,
    texts.texts,
    await vectorsOf(DESIGN),
    DESIGN,
  );
  const result = score(set.rows, texts.texts, fed.eventOf, fed.adds);
  const latest = scoreboard.latest(name);
  // The accepted design to compare with: the latest that scored the set, or
  // else the latest accepted design.
  const against = latest?.entry ?? scoreboard.entries.at(-1) ?? null;
  const stored = against === null ? null : readEvents(against.design, set);
  // A design with no events on these labels, as on an exam set, runs from
  // its pin in this run (#3189).
  const live =
    against === null || stored !== null
      ? null
      : (
          await feed(
            set.rows,
            texts.texts,
            await vectorsOf(against.pin.design),
            against.pin.design,
          )
        ).eventOf;
  const againstEvents = stored ?? live;
  const change =
    againstEvents === null
      ? null
      : changeOfMainScore(set.rows, fed.eventOf, againstEvents);
  // The main score of that design on the set.
  const againstF05 =
    live === null
      ? (latest?.score.conll.f05 ?? null)
      : score(set.rows, texts.texts, live, []).conll.f05;
  const acceptedScore =
    against === null || againstF05 === null
      ? null
      : { design: against.design, f05: againstF05 };
  if (decision.firstScore) recordFirstScore(set);

  const entry: SetEntry = {
    role: decision.role,
    labelsSha256: set.metadata.labelsSha256,
    reports: result.reports,
    muc: rounded(result.muc),
    bCubed: rounded(result.bCubed),
    ceafE: rounded(result.ceafE),
    blanc: rounded(result.blanc),
    pair: rounded(result.pair),
    conll: { f1: round(result.conll.f1), f05: round(result.conll.f05) },
  };
  const payload = {
    set: name,
    role: decision.role,
    at: new Date().toISOString(),
    metricsVersion: METRICS_VERSION,
    pin,
    vanished: texts.vanished,
    changed: texts.changed,
    change: change === null ? null : { against: against!.design, ...change },
    ...result,
    eventOf: Object.fromEntries(fed.eventOf),
    adds: fed.adds,
    // The events of the accepted design when it ran in this run.
    accepted:
      live === null
        ? null
        : {
            design: against!.design,
            conllF05: againstF05,
            eventOf: Object.fromEntries(live),
          },
  };
  const file = join(RESULTS_FOLDER, `${name}.json`);
  mkdirSync(RESULTS_FOLDER, { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 1));
  if (change !== null && decision.role === 'regression')
    regressionSets[name] = change;
  if (change !== null && decision.role === 'exam')
    exams.push({
      file,
      payload,
      mainScore: result.conll.f05,
      baselines: [
        result.baselines.allSingletons.conll.f05,
        result.baselines.allInOne.conll.f05,
      ],
      change,
    });

  console.log(
    `\n${name} (${decision.role}): ${result.reports} of ${set.rows.length} reports, ${texts.vanished.length} vanished, ${texts.changed.length} changed text`,
  );
  for (const { id, reason } of texts.vanished.slice(0, 5))
    console.log(`  vanished ${id}: ${reason}`);
  for (const { id } of texts.changed.slice(0, 5))
    console.log(`  changed ${id}`);
  console.log(
    `  ${'CoNLL F0.5 (main)'.padEnd(20)} ${mainLine(result, acceptedScore, change)}`,
  );
  console.log(`  ${''.padEnd(20)}     P      R      F1     F0.5`);
  for (const [label, metric] of [
    ['MUC', 'muc'],
    ['B-cubed', 'bCubed'],
    ['CEAF-e', 'ceafE'],
    ['BLANC', 'blanc'],
    ['pair', 'pair'],
  ] as const)
    console.log(row(label, result[metric]));
  console.log(
    `  ${'CoNLL'.padEnd(20)}                ${result.conll.f1.toFixed(3)}  ${result.conll.f05.toFixed(3)}`,
  );
  if (result.crossPublisher !== null && result.samePublisher !== null) {
    console.log(row('pair, two publishers', result.crossPublisher));
    console.log(row('pair, one publisher', result.samePublisher));
  }
  if (latest !== null && latest.score.labelsSha256 !== entry.labelsSha256)
    console.log(
      `  The labels changed since design ${latest.entry.design} was accepted.`,
    );
  console.log(
    `  ${result.addMs.adds} adds: median ${result.addMs.median.toFixed(0)} ms, p90 ${result.addMs.p90.toFixed(0)} ms, max ${result.addMs.max.toFixed(0)} ms; ${result.falseJoins.length} false-join events, ${result.falseSplits.length} false-split events (results/${name}.json)`,
  );

  accepted[name] = entry;
  events.push({ set, eventOf: fed.eventOf });
  if (texts.vanished.length > 0 || texts.changed.length > 0)
    refusals.push(`${name} has vanished or changed texts.`);
  const { allSingletons, allInOne } = result.baselines;
  if (result.conll.f05 <= Math.max(allSingletons.conll.f05, allInOne.conll.f05))
    refusals.push(
      `${name}: the CoNLL F0.5 ${result.conll.f05.toFixed(3)} does not beat both baselines (all singletons ${allSingletons.conll.f05.toFixed(3)}, all in one ${allInOne.conll.f05.toFixed(3)}).`,
    );
  const worse = change === null ? null : scoreboard.worse(name, entry, change);
  if (worse !== null) {
    refusals.push(worse);
    console.log(`  WORSE: ${worse}`);
  }
}

// The exam's one score gives the verdict of the candidate against the
// accepted design (README.md, "Roles").
for (const exam of exams) {
  const result = verdict({
    exam: exam.change,
    mainScore: exam.mainScore,
    baselines: exam.baselines,
    regressionSets,
  });
  writeFileSync(
    exam.file,
    JSON.stringify({ ...exam.payload, verdict: result }, null, 1),
  );
  console.log(
    `\nExam verdict of design ${DESIGN.name}: ${result.result} (interval ${signed(result.exam.low)} to ${signed(result.exam.high)}; beats both baselines: ${result.beatsBaselines}; no regression set worse: ${result.noRegression}).`,
  );
}

if (values.accept !== undefined) {
  if (refusals.length > 0)
    throw new Error(
      `Design ${values.accept} is not accepted:\n${refusals.join('\n')}`,
    );
  scoreboard.with({ ...draft(values.accept), sets: accepted }).write();
  writeEvents(values.accept, events);
  console.log(`\nDesign ${values.accept} is accepted in scoreboard.json.`);
}

function draft(design: string): Omit<Entry, 'sets'> {
  return {
    design,
    acceptedAt: new Date().toISOString(),
    metricsVersion: METRICS_VERSION,
    pin,
  };
}

function recordFirstScore(set: EvalSet): void {
  writeFileSync(
    join(set.folder, 'set.json'),
    `${JSON.stringify({ ...set.metadata, firstScoredAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function rounded(value: Score): SetEntry['muc'] {
  return {
    precision: round(value.precision),
    recall: round(value.recall),
    f1: round(value.f1),
    f05: round(value.f05),
  };
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
}

// The main score beside the two baselines and the latest accepted design.
function mainLine(
  result: SetScore,
  accepted: { readonly design: string; readonly f05: number } | null,
  change: Interval | null,
): string {
  const parts = [
    result.conll.f05.toFixed(3),
    `all singletons ${result.baselines.allSingletons.conll.f05.toFixed(3)}`,
    `all in one ${result.baselines.allInOne.conll.f05.toFixed(3)}`,
  ];
  if (accepted !== null)
    parts.push(`design ${accepted.design} ${accepted.f05.toFixed(3)}`);
  if (change !== null)
    parts.push(
      `change ${signed(change.observed)}, 95% interval ${signed(change.low)} to ${signed(change.high)} (${change.blocks} blocks)`,
    );
  return parts.join('; ');
}

function row(label: string, value: Score): string {
  return `  ${label.padEnd(20)} ${[value.precision, value.recall, value.f1, value.f05].map((x) => x.toFixed(3)).join('  ')}`;
}
