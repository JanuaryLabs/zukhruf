import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { MockEmbeddingModelV4 } from 'ai/test';

import { Collection } from '@zukhruf/embeddings';

import { EventDetector, design3152b } from './index.ts';
import { leadOf } from './lead.ts';
import { numbersOf } from './numbers.ts';

// The bundles of research rounds #3130 and #3152 on the maintainer's Mac.
// Round #3130 holds the Gun Violence Corpus, its vectors and its metric code.
// The Gun Violence Corpus holds news texts of many publishers. Its CC BY 4.0
// license covers only the rights of the corpus authors, so neither the texts
// nor their vectors are in this repository. Round #3152 holds the replica of
// the detector, and its second selection (3152b) holds the frozen design
// (plan.json). Without the bundles, the test is skipped.
const rounds = join(
  homedir(),
  '.codex/visualizations/2026/10/23/01a16a1c-424c-7793-8ca9-02cc1c715d82',
);
const round3130 = join(rounds, 'feature-scorer-3130');
const round3152 = join(rounds, 'feature-scorer-3152');
const round3152b = join(rounds, 'feature-scorer-3152b');

type Row = {
  id: string;
  title: string | null;
  body: string;
  published: string;
  event: string;
};

type Scores = {
  f05: number;
  precision: number | null;
  recall: number | null;
  b3: { precision: number; recall: number; f05: number };
};

// The metric and arrival-order code of round #3130, so that the scores are
// calculated the same way.
type Research = {
  shuffle: (items: number[], seed: number) => number[];
  metrics: (rows: Row[], groups: string[][]) => Scores;
  partitionDifference: (
    a: string[][],
    b: string[][],
  ) => { changedPairs: number };
};

// One report as the replica of round #3152 sees it (scripts/data.ts).
type Doc = {
  id: string;
  event: string;
  publisher: string | null;
  publishedAt: number;
  day: number;
  text: string | null;
  numbers: Set<string>;
  vector: Float32Array | null;
  order: number;
};

// The replica of round #3152: its pair features and its detector, each a
// file of the round.
type Replica = {
  Context: new (
    docs: readonly Doc[],
    sims: Float64Array,
    entities: null,
  ) => {
    features: (i: number, j: number, similarity: number) => object;
    index: Map<string, number>;
  };
  similarityMatrix: (docs: readonly Doc[]) => Float64Array;
  runDetector: (
    docs: readonly Doc[],
    sims: Float64Array,
    options: {
      threshold: number;
      spanDays: null;
      score: (a: Doc, b: Doc, similarity: number) => number;
    },
  ) => Map<string, number>;
  probability: (
    model: {
      features: string[];
      mean: number[];
      sd: number[];
      weights: number[];
    },
    features: object,
  ) => number;
};

type Design = {
  features: string[];
  threshold: number;
  model: {
    intercept: number;
    terms: Record<string, { weight: number; mean: number; sd: number }>;
  };
};

// The files of a round, as the round wrote them.
function read<T>(round: string, path: string): T {
  return JSON.parse(readFileSync(join(round, path), 'utf8'));
}

// The EmbeddingGemma 2 vectors of round #3130, by input text.
function researchVectors(): Map<string, number[]> {
  const folder = join(round3130, 'results/vectors/gvc');
  const vectors = new Map<string, number[]>();
  for (const file of readdirSync(folder).filter((name) =>
    name.endsWith('.json'),
  )) {
    const { inputs } = read<{ inputs: string[] }>(folder, file);
    const bytes = readFileSync(join(folder, file.replace('.json', '.bin')));
    const all = new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 4,
    );
    const dimension = all.length / inputs.length;
    for (const [index, input] of inputs.entries())
      vectors.set(input, [
        ...all.subarray(index * dimension, (index + 1) * dimension),
      ]);
  }
  return vectors;
}

// The partition that the replica of round #3152 gives for the reports in
// this arrival order, with the weights of plan.json.
async function replicaGroups(
  order: readonly Row[],
  idOf: ReadonlyMap<string, string>,
  vectors: ReadonlyMap<string, number[]>,
  publisherOf: (row: Row) => string | undefined,
): Promise<string[][]> {
  const replica: Replica = {
    ...(await import(join(round3152, 'scripts/features.ts'))),
    ...(await import(join(round3152, 'scripts/detector.ts'))),
    ...(await import(join(round3130, 'scripts/model.ts'))),
  };
  const { design } = read<{ design: Design }>(round3152b, 'plan.json');
  const terms = design.features.map((feature) => {
    const term = design.model.terms[feature];
    if (term === undefined) throw new Error(`plan.json has no ${feature}`);
    return term;
  });
  const model = {
    features: design.features,
    mean: terms.map((term) => term.mean),
    sd: terms.map((term) => term.sd),
    weights: [design.model.intercept, ...terms.map((term) => term.weight)],
  };
  const docs = order.map((row, index): Doc => {
    // The 'frozen' lead and number rules of the replica (its scripts/lead.ts):
    // the lead and the numbers of the package.
    const lead = leadOf(row.title ?? '', row.body, design3152b.lead);
    const text =
      lead.title === null || lead.sentences.length === 0
        ? null
        : `title: ${lead.title} | text: ${lead.title}\n${lead.sentences.join(' ')}`;
    const numbers = numbersOf(`${lead.title ?? ''}\n${row.body}`);
    const vector = text === null ? undefined : vectors.get(text);
    const length = Math.hypot(...(vector ?? []));
    const publishedAt = Date.parse(row.published);
    return {
      id: idOf.get(row.id) ?? row.id,
      event: row.event,
      publisher: publisherOf(row) ?? null,
      publishedAt,
      day: Math.floor(publishedAt / 86_400_000),
      text,
      numbers,
      vector:
        vector === undefined
          ? null
          : Float32Array.from(vector, (value) => value / length),
      order: index,
    };
  });
  const sims = replica.similarityMatrix(docs);
  const context = new replica.Context(docs, sims, null);
  const eventOf = replica.runDetector(docs, sims, {
    threshold: design.threshold,
    spanDays: null,
    score: (a, b, similarity) =>
      replica.probability(
        model,
        context.features(
          context.index.get(a.id) ?? -1,
          context.index.get(b.id) ?? -1,
          similarity,
        ),
      ),
  });
  return [...Map.groupBy(eventOf.keys(), (id) => eventOf.get(id)).values()].map(
    (members) => members.map((id) => id.slice('000 '.length)),
  );
}

// The partition that the detector gives for the reports in this arrival
// order.
async function detectorGroups(
  order: readonly Row[],
  idOf: ReadonlyMap<string, string>,
  model: MockEmbeddingModelV4,
  publisherOf: (row: Row) => string | undefined,
): Promise<string[][]> {
  using database = new DatabaseSync(':memory:');
  const detector = new EventDetector({
    database,
    vectors: new Collection({ database, model }),
    design: design3152b,
  });
  await detector.add(
    order.map((row) => {
      const publisher = publisherOf(row);
      return {
        id: idOf.get(row.id) ?? row.id,
        title: row.title ?? '',
        body: row.body,
        publishedAt: new Date(row.published),
        ...(publisher !== undefined && { publisher }),
      };
    }),
  );
  // The replica clusters the window again at the end of its stream. The
  // detector does it when a report of a later day arrives. A headline-only
  // report stays alone, so it changes no other event.
  const last = Math.max(...order.map((row) => Date.parse(row.published)));
  await detector.add([
    {
      id: 'next-day',
      title: 'Next day',
      body: '',
      publishedAt: new Date(last + 86_400_000),
    },
  ]);
  return detector
    .events({ since: new Date(0) })
    .map((event) =>
      event.members
        .filter((id) => id !== 'next-day')
        .map((id) => id.slice('000 '.length)),
    )
    .filter((members) => members.length > 0);
}

test(
  'a replay of the Gun Violence Corpus gives the partition and the scores of design 3152',
  {
    skip:
      !(existsSync(round3130) && existsSync(round3152)) &&
      'the bundles of rounds #3130 and #3152 are not on this machine',
  },
  async () => {
    const research: Research = await import(
      join(round3130, 'scripts/common.ts')
    );
    const rows = read<Row[]>(round3130, 'data/gvc.json');
    const vectors = researchVectors();
    // The model gives the vector of the round for each text, and fails on a
    // text that the round did not embed. So each vector text of the detector
    // must be the text of the round.
    const model = new MockEmbeddingModelV4({
      maxEmbeddingsPerCall: Infinity,
      doEmbed: async ({ values }) => ({
        embeddings: values.map((text) => {
          const vector = vectors.get(text);
          if (vector === undefined)
            throw new Error(`Round #3130 did not embed ${text}`);
          return vector;
        }),
        warnings: [],
      }),
    });
    // The arrival order of round #3130 (seed 0): by publish day, and equal
    // days in a seeded shuffle.
    const slots = research.shuffle(
      rows.map((_, index) => index),
      0,
    );
    const order = slots
      .flatMap((index, rank) => {
        const row = rows[index];
        return row === undefined ? [] : [{ row, rank }];
      })
      .toSorted(
        (a, b) =>
          Date.parse(a.row.published) - Date.parse(b.row.published) ||
          a.rank - b.rank,
      )
      .map(({ row }) => row);
    // The rounds break ties by the row index of the corpus file. The
    // detector breaks them by report id, so each id starts with the row
    // index.
    const idOf = new Map(
      rows.map((row, index) => [
        row.id,
        `${String(index).padStart(3, '0')} ${row.id}`,
      ]),
    );
    // The corpus gives no publishers. So that the replay also compares the
    // same-publisher term with plan.json, a second replay gives each report
    // one of three made-up publishers, by its row index.
    const none = () => undefined;
    const three = (row: Row) => `publisher ${rows.indexOf(row) % 3}`;

    const groups = await detectorGroups(order, idOf, model, none);
    const withPublishers = await detectorGroups(order, idOf, model, three);

    const expected = await replicaGroups(order, idOf, vectors, none);
    const scores = research.metrics(rows, groups);
    const expectedScores = research.metrics(rows, expected);
    assert.equal(
      research.partitionDifference(expected, groups).changedPairs,
      0,
    );
    assert.equal(
      research.partitionDifference(
        await replicaGroups(order, idOf, vectors, three),
        withPublishers,
      ).changedPairs,
      0,
    );
    assert.ok(Math.abs(scores.b3.f05 - expectedScores.b3.f05) < 1e-9);
    assert.ok(Math.abs(scores.f05 - expectedScores.f05) < 1e-9);
    // plan.json (3152b) implementationCheck.scores.gvc
    assert.ok(Math.abs(scores.b3.f05 - 0.947) < 0.0005);
    assert.ok(Math.abs(scores.f05 - 0.857) < 0.0005);
  },
);
