import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { MockEmbeddingModelV4 } from 'ai/test';

import { Collection } from '@zukhruf/embeddings';

import { EventDetector } from './index.ts';

// The bundle of research round #3130 on the maintainer's Mac. The Gun Violence
// Corpus holds news texts of many publishers. Its CC BY 4.0 license covers
// only the rights of the corpus authors, so neither the texts nor their
// vectors are in this repository. Without the bundle, the test is skipped.
const bundle = join(
  homedir(),
  '.codex/visualizations/2026/10/23/01a16a1c-424c-7793-8ca9-02cc1c715d82/feature-scorer-3130',
);

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

// The metric and arrival-order code of the round itself, so that the scores
// are calculated the same way.
type Research = {
  shuffle: (items: number[], seed: number) => number[];
  metrics: (rows: Row[], groups: string[][]) => Scores;
  partitionDifference: (
    a: string[][],
    b: string[][],
  ) => { changedPairs: number };
};

// The files of the round, as the round wrote them.
function read<T>(path: string): T {
  return JSON.parse(readFileSync(join(bundle, path), 'utf8'));
}

// The EmbeddingGemma 2 vectors of the round, by input text.
function researchVectors(): Map<string, number[]> {
  const folder = join(bundle, 'results/vectors/gvc');
  const vectors = new Map<string, number[]>();
  for (const file of readdirSync(folder).filter((name) =>
    name.endsWith('.json'),
  )) {
    const { inputs } = read<{ inputs: string[] }>(
      join('results/vectors/gvc', file),
    );
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

test(
  'a replay of the Gun Violence Corpus gives the partition and the scores of round #3130',
  { skip: !existsSync(bundle) && 'the #3130 bundle is not on this machine' },
  async () => {
    const research: Research = await import(join(bundle, 'scripts/common.ts'));
    const rows = read<Row[]>('data/gvc.json');
    const expected = read<{ metrics: Scores; groups: string[][] }>(
      'results/test/gvc-design.json',
    );
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
    // The arrival order of the round (seed 0): by publish day, and equal days
    // in a seeded shuffle.
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
    using database = new DatabaseSync(':memory:');
    const detector = new EventDetector({
      database,
      vectors: new Collection({ database, model }),
    });

    // The round breaks ties by the row index of the corpus file. The detector
    // breaks them by report id, so each id starts with the row index.
    const idOf = new Map(
      rows.map((row, index) => [
        row.id,
        `${String(index).padStart(3, '0')} ${row.id}`,
      ]),
    );
    await detector.add(
      order.map((row) => ({
        id: idOf.get(row.id) ?? row.id,
        title: row.title ?? '',
        body: row.body,
        publishedAt: new Date(row.published),
      })),
    );
    // The round clusters the window again at the end of its stream. The
    // detector does it when a report of a later day arrives. A headline-only
    // report stays alone, so it changes no other event.
    const last = Math.max(...rows.map((row) => Date.parse(row.published)));
    await detector.add([
      {
        id: 'next-day',
        title: 'Next day',
        body: '',
        publishedAt: new Date(last + 86_400_000),
      },
    ]);
    const groups = detector
      .events({ since: new Date(0) })
      .map((event) =>
        event.members
          .filter((id) => id !== 'next-day')
          .map((id) => id.slice('000 '.length)),
      )
      .filter((members) => members.length > 0);
    const scores = research.metrics(rows, groups);

    assert.equal(
      research.partitionDifference(expected.groups, groups).changedPairs,
      0,
    );
    assert.ok(Math.abs(scores.b3.f05 - expected.metrics.b3.f05) < 1e-9);
    assert.ok(Math.abs(scores.f05 - expected.metrics.f05) < 1e-9);
    assert.ok(Math.abs(scores.b3.f05 - 0.948) < 0.0005);
    assert.ok(Math.abs(scores.f05 - 0.868) < 0.0005);
  },
);
