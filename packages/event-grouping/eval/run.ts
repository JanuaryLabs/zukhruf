import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { cosineSimilarity, embed } from 'ai';

import { Collection } from '@zukhruf/embeddings';

import { readEvents, writeEvents } from './accepted.ts';
import {
  type EvalSet,
  type TextKind,
  readMetadata,
  readSet,
  setNames,
} from './answer-key.ts';
import { type Interval, pairedBootstrap } from './bootstrap.ts';
import { feed } from './feed.ts';
import type { Partition } from './metrics/contingency.ts';
import type { Score } from './metrics/f-measure.ts';
import { METRICS_VERSION, mainScore } from './metrics/metrics.ts';
import { committed, currentPin } from './pin.ts';
import { decide } from './roles.ts';
import { type SetScore, partitions, score } from './score.ts';
import { type Entry, Scoreboard, type SetEntry } from './scoreboard.ts';
import { EcbPlusCorpus } from './texts/ecbplus.ts';
import { GunViolenceCorpus } from './texts/gvc.ts';
import { HeadlineGroupingRelease } from './texts/hlgd.ts';
import { CACHE_FOLDER, type TextSource } from './texts/text-source.ts';
import { WcepRows } from './texts/wcep.ts';
import { WebPages } from './texts/web.ts';

// Runs the frozen design of the package on the evaluation sets, and compares
// each score with the latest accepted design (README.md).
const USAGE = `Usage: nx run event-grouping:eval -- [set ...] [--refresh] [--exam] [--accept <design>]

  set               The sets to score. All sets when none is given.
  --refresh         Get each text from its source again, not from the cache.
  --exam            Also score the exam sets that were never scored.
  --accept <design> Record the scores as an accepted design in scoreboard.json.

Environment:
  EVAL_EMBEDDING_URL    The OpenAI-compatible base URL of the embedding server.
  EVAL_EMBEDDING_MODEL  The model name on that server (default embeddinggemma-2).`;

// The paired bootstrap of the change against the latest accepted design
// (#3182). The seed is fixed, so a run gives the same interval each time.
const REPLICATES = 2000;
const SEED = 3182;

const SOURCES: Record<TextKind, TextSource> = {
  gvc: new GunViolenceCorpus(),
  ecbplus: new EcbPlusCorpus(),
  hlgd: new HeadlineGroupingRelease(),
  wcep: new WcepRows(),
  web: new WebPages(),
};

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
const baseURL = process.env['EVAL_EMBEDDING_URL'];
if (values.help || baseURL === undefined) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}
if (values.accept !== undefined && positionals.length > 0)
  throw new Error('--accept records a design on every set: name no set.');

const scoreboard = Scoreboard.read();
const pin = currentPin();
if (values.accept !== undefined) {
  if (!committed())
    throw new Error(
      `--accept pins the design to commit ${pin.commit}, but src/ has changes that are not committed. Commit the design first.`,
    );
  // Refuses a name that the scoreboard has, before the run.
  scoreboard.with({ ...draft(values.accept), sets: {} });
}
const holds = scoreboard.designOf(pin);
console.log(
  holds === null
    ? `The package holds a design that is not accepted (src/frozen-design.ts sha256 ${pin.frozenDesignSha256}).`
    : `The package holds design ${holds.design} (pinned to commit ${holds.pin.commit}).`,
);

const modelId = process.env['EVAL_EMBEDDING_MODEL'] ?? 'embeddinggemma-2';
const model = createOpenAICompatible({
  name: 'llama.cpp',
  baseURL,
}).embeddingModel(modelId);
await checkModel();

const accepted: Record<string, SetEntry> = {};
const events: { set: EvalSet; eventOf: Partition }[] = [];
const refusals: string[] = [];
for (const name of positionals.length > 0 ? positionals : setNames()) {
  const decision = decide(readMetadata(name), values.exam);
  if (!decision.run) {
    console.log(`\n${name}: skipped. ${decision.reason}`);
    continue;
  }
  const set = readSet(name);
  const texts = await SOURCES[set.metadata.text].texts(set, values.refresh);
  mkdirSync(join(CACHE_FOLDER, 'vectors'), { recursive: true });
  using vectorDatabase = new DatabaseSync(
    join(CACHE_FOLDER, 'vectors', `${name}.sqlite`),
  );
  const fed = await feed(
    set.rows,
    texts.texts,
    new Collection({ database: vectorDatabase, model }),
  );
  const result = score(set.rows, texts.texts, fed.eventOf, fed.adds);
  const latest = scoreboard.latest(name);
  const latestEvents =
    latest === null ? null : readEvents(latest.entry.design, set);
  const change =
    latestEvents === null ? null : bootstrap(set, fed.eventOf, latestEvents);
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
  mkdirSync(RESULTS_FOLDER, { recursive: true });
  writeFileSync(
    join(RESULTS_FOLDER, `${name}.json`),
    JSON.stringify(
      {
        set: name,
        role: decision.role,
        at: new Date().toISOString(),
        embeddingModel: modelId,
        metricsVersion: METRICS_VERSION,
        pin,
        vanished: texts.vanished,
        changed: texts.changed,
        change:
          change === null ? null : { against: latest!.entry.design, ...change },
        ...result,
        eventOf: Object.fromEntries(fed.eventOf),
        adds: fed.adds,
      },
      null,
      1,
    ),
  );

  console.log(
    `\n${name} (${decision.role}): ${result.reports} of ${set.rows.length} reports, ${texts.vanished.length} vanished, ${texts.changed.length} changed text`,
  );
  for (const { id, reason } of texts.vanished.slice(0, 5))
    console.log(`  vanished ${id}: ${reason}`);
  for (const { id } of texts.changed.slice(0, 5))
    console.log(`  changed ${id}`);
  console.log(
    `  ${'CoNLL F0.5 (main)'.padEnd(20)} ${mainLine(result, latest, change)}`,
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
  if (
    latest !== null &&
    latest.score.labelsSha256 === entry.labelsSha256 &&
    change === null
  )
    refusals.push(
      `${name}: accepted/${latest.entry.design}.json has no events on these labels, so no change can be computed.`,
    );
  const worse = change === null ? null : scoreboard.worse(name, entry, change);
  if (worse !== null) {
    refusals.push(worse);
    console.log(`  WORSE: ${worse}`);
  }
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
    embeddingModel: modelId,
    pin,
  };
}

// The change of the main score against the latest accepted design, on the
// reports that both designs scored.
function bootstrap(
  set: EvalSet,
  eventOf: Partition,
  latest: Partition,
): Interval {
  const both = set.rows.filter(
    (row) => eventOf.has(row.id) && latest.has(row.id),
  );
  const { gold, predicted } = partitions(both, eventOf);
  return pairedBootstrap({
    gold,
    run: predicted,
    latest: partitions(both, latest).predicted,
    statistic: mainScore,
    replicates: REPLICATES,
    seed: SEED,
  });
}

// The endpoint must serve the model that the parameters were frozen for
// (ADR 0001): its vector of the probe text must be the vector of the round.
async function checkModel(): Promise<void> {
  const probe: { text: string; vector: number[] } = JSON.parse(
    readFileSync(join(import.meta.dirname, 'embedding-probe.json'), 'utf8'),
  );
  const { embedding } = await embed({ model, value: probe.text });
  const agreement = cosineSimilarity(embedding, probe.vector);
  if (agreement < 0.99999)
    throw new Error(
      `${baseURL} does not serve the EmbeddingGemma 2 Q8_0 model of round #3130 (probe cosine ${agreement}).`,
    );
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
  latest: ReturnType<Scoreboard['latest']>,
  change: Interval | null,
): string {
  const parts = [
    result.conll.f05.toFixed(3),
    `all singletons ${result.baselines.allSingletons.conll.f05.toFixed(3)}`,
    `all in one ${result.baselines.allInOne.conll.f05.toFixed(3)}`,
  ];
  if (latest !== null)
    parts.push(
      `design ${latest.entry.design} ${latest.score.conll.f05.toFixed(3)}`,
    );
  if (change !== null)
    parts.push(
      `change ${signed(change.observed)}, 95% interval ${signed(change.low)} to ${signed(change.high)} (${change.blocks} blocks)`,
    );
  return parts.join('; ');
}

function row(label: string, value: Score): string {
  return `  ${label.padEnd(20)} ${[value.precision, value.recall, value.f1, value.f05].map((x) => x.toFixed(3)).join('  ')}`;
}
