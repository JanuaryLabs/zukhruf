import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { cosineSimilarity, embed } from 'ai';

import { Collection } from '@zukhruf/embeddings';

import {
  type EvalSet,
  type TextKind,
  readSet,
  setNames,
} from './answer-key.ts';
import { feed } from './feed.ts';
import { decide } from './roles.ts';
import { score } from './score.ts';
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

const modelId = process.env['EVAL_EMBEDDING_MODEL'] ?? 'embeddinggemma-2';
const model = createOpenAICompatible({
  name: 'llama.cpp',
  baseURL,
}).embeddingModel(modelId);
await checkModel();

const scoreboard = Scoreboard.read();
const accepted: Record<string, SetEntry> = {};
const refusals: string[] = [];
for (const name of positionals.length > 0 ? positionals : setNames()) {
  const set = readSet(name);
  const decision = decide(set.metadata, values.exam);
  if (!decision.run) {
    console.log(`\n${name}: skipped. ${decision.reason}`);
    continue;
  }
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
  mkdirSync(RESULTS_FOLDER, { recursive: true });
  writeFileSync(
    join(RESULTS_FOLDER, `${name}.json`),
    JSON.stringify(
      {
        set: name,
        role: decision.role,
        at: new Date().toISOString(),
        embeddingModel: modelId,
        vanished: texts.vanished,
        changed: texts.changed,
        ...result,
        adds: fed.adds,
      },
      null,
      1,
    ),
  );
  if (decision.firstScore) recordFirstScore(set);

  const entry: SetEntry = {
    role: decision.role,
    labelsSha256: set.metadata.labelsSha256,
    reports: result.reports,
    pair: rounded(result.pair),
    bcubed: rounded(result.bcubed),
  };
  const latest = scoreboard.latest(name);
  console.log(
    `\n${name} (${decision.role}): ${result.reports} of ${set.rows.length} reports, ${texts.vanished.length} vanished, ${texts.changed.length} changed text`,
  );
  for (const { id, reason } of texts.vanished.slice(0, 5))
    console.log(`  vanished ${id}: ${reason}`);
  for (const { id } of texts.changed.slice(0, 5))
    console.log(`  changed ${id}`);
  console.log(line('pair', entry.pair, latest?.score.pair));
  console.log(line('b-cubed', entry.bcubed, latest?.score.bcubed));
  if (result.crossPublisher !== null && result.samePublisher !== null) {
    console.log(line('pair, two publishers', rounded(result.crossPublisher)));
    console.log(line('pair, one publisher', rounded(result.samePublisher)));
  }
  if (latest !== null) {
    console.log(`  (the change is against design ${latest.design})`);
    if (latest.score.labelsSha256 !== entry.labelsSha256)
      console.log('  The labels changed since that design was accepted.');
  }
  console.log(
    `  ${result.addMs.adds} adds: median ${result.addMs.median.toFixed(0)} ms, p90 ${result.addMs.p90.toFixed(0)} ms, max ${result.addMs.max.toFixed(0)} ms; ${result.falseJoins.length} false-join events, ${result.falseSplits.length} false-split events (results/${name}.json)`,
  );

  accepted[name] = entry;
  if (texts.vanished.length > 0 || texts.changed.length > 0)
    refusals.push(`${name} has vanished or changed texts.`);
  const worse = scoreboard.worse(name, entry);
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
  const entry: Entry = {
    design: values.accept,
    acceptedAt: new Date().toISOString(),
    embeddingModel: modelId,
    sets: accepted,
  };
  scoreboard.with(entry).write();
  console.log(`\nDesign ${values.accept} is accepted in scoreboard.json.`);
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

function rounded(value: {
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f05: number;
}): SetEntry['pair'] {
  const round = (x: number | null) =>
    x === null ? null : Math.round(x * 1000) / 1000;
  return {
    precision: round(value.precision),
    recall: round(value.recall),
    f05: round(value.f05) ?? 0,
  };
}

function line(
  label: string,
  current: SetEntry['pair'],
  before?: SetEntry['pair'],
): string {
  const cell = (name: string, value: number | null, old?: number | null) => {
    const shown = value === null ? '  -  ' : value.toFixed(3);
    if (old === undefined || old === null || value === null)
      return `${name} ${shown}`;
    const change = value - old;
    return `${name} ${shown} (${change >= 0 ? '+' : ''}${change.toFixed(3)})`;
  };
  return `  ${label.padEnd(22)} ${cell('P', current.precision, before?.precision)}  ${cell('R', current.recall, before?.recall)}  ${cell('F0.5', current.f05, before?.f05)}`;
}
