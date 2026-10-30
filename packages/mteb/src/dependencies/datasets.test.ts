import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { z } from 'zod';

import { TemporaryFiles } from '@zukhruf/testing/fs';
import { HttpServer } from '@zukhruf/testing/http';

import { AbsTask, type MTEBModels } from '../abstasks/abstask.ts';
import { TaskMetadata } from '../abstasks/task-metadata.ts';
import type { Score } from '../types/result.ts';
import { type Dataset, type DatasetDict, loadDataset } from './datasets.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'datasets');

// The splits of a load, with each row as its entries, so that the order of
// the columns of each row counts.
function splitsOf(dict: DatasetDict) {
  return [...dict].map(([split, dataset]) => ({
    split,
    columns: dataset.columnNames,
    rows: dataset.rows.map((row) => Object.entries(row)),
  }));
}

const expectedSchema = z.record(
  z.string(),
  z.array(
    z.object({
      name: z.string().nullable(),
      splits: z.array(
        z.object({
          split: z.string(),
          columns: z.array(z.string()),
          rows: z.array(z.record(z.string(), z.unknown())),
        }),
      ),
    }),
  ),
);

test('each layout of data files loads the splits, columns and rows that load_dataset of datasets 5.1.0 gives, in its order', async () => {
  const expected = expectedSchema.parse(
    JSON.parse(await readFile(join(FIXTURES, 'expected.json'), 'utf8')),
  );
  let loads = 0;

  for (const [folder, cases] of Object.entries(expected))
    for (const { name, splits } of cases) {
      const dict = await loadDataset({
        path: join(FIXTURES, folder),
        revision: 'unused',
        name,
      });

      assert.deepEqual(
        splitsOf(dict),
        splits.map(({ split, columns, rows }) => ({
          split,
          columns,
          rows: rows.map((row) => Object.entries(row)),
        })),
        `${folder} ${name ?? '(default)'}`,
      );
      loads++;
    }

  assert.equal(loads, 9);
});

test('a dataset of CSV files throws, because this port reads JSON and parquet files only', async () => {
  await using folder = await new TemporaryFiles().directory('mteb-csv-');
  await writeFile(join(folder.path, 'train.csv'), 'a,b\n1,2\n');

  await assert.rejects(
    loadDataset({ path: folder.path, revision: 'unused' }),
    /reads JSON and parquet data files, not \.csv files/u,
  );
});

// A stand-in for the HuggingFace Hub, which CI cannot reach. It answers the
// tree of the repository in two pages, as the Hub pages a long tree, and the
// files at the revision; anything else is 404.
async function hub(files: Readonly<Record<string, Uint8Array>>): Promise<{
  readonly origin: string;
  readonly requests: () => readonly string[];
  [Symbol.asyncDispose](): Promise<void>;
}> {
  const requests: string[] = [];
  const tree = '/api/datasets/org/pairs/tree/rev1?recursive=true&expand=false';
  const paths = Object.keys(files);
  const entries = (list: readonly string[]) =>
    list.map((path) => ({ type: 'file', oid: 'x', path }));
  const server = await new HttpServer().start((request, response) => {
    const url = request.url ?? '';
    requests.push(url);
    if (url === tree) {
      response.setHeader('Link', `<${origin()}${tree}&cursor=2>; rel="next"`);
      response.end(
        JSON.stringify([
          { type: 'directory', oid: 'y', path: 'data' },
          ...entries(paths.slice(0, 1)),
        ]),
      );
      return;
    }
    if (url === `${tree}&cursor=2`) {
      response.end(JSON.stringify(entries(paths.slice(1))));
      return;
    }
    const prefix = '/datasets/org/pairs/resolve/rev1/';
    const file = url.startsWith(prefix)
      ? files[url.slice(prefix.length)]
      : undefined;
    if (file === undefined) {
      response.statusCode = 404;
      response.end('Entry not found');
      return;
    }
    response.end(file);
  });
  const origin = () => server.origin;
  return {
    origin: server.origin,
    requests: () => [...requests],
    [Symbol.asyncDispose]: () => server.cleanup(),
  };
}

const jsonl = (rows: readonly object[]) =>
  rows.map((row) => `${JSON.stringify(row)}\n`).join('');

test('a Hub dataset without a card lists the files of its tree page by page, infers its splits, and loads again from the cache without a request', async () => {
  await using server = await hub({
    'test.json.gz': gzipSync(
      JSON.stringify([
        { sentence1: ['q1', 'q2'], sentence2: ['d1', 'd2'], labels: [1, 0] },
      ]),
    ),
    'validation.json.gz': gzipSync(
      jsonl([{ sentence1: ['q3'], sentence2: ['d3'], labels: [1] }]),
    ),
    '.gitattributes': new TextEncoder().encode('*.gz filter=lfs\n'),
  });
  await using cache = await new TemporaryFiles().directory('mteb-hub-');
  const options = {
    path: 'org/pairs',
    revision: 'rev1',
    endpoint: server.origin,
    cacheFolder: cache.path,
  };
  const expected = [
    {
      split: 'validation',
      columns: ['sentence1', 'sentence2', 'labels'],
      rows: [
        [
          ['sentence1', ['q3']],
          ['sentence2', ['d3']],
          ['labels', [1]],
        ],
      ],
    },
    {
      split: 'test',
      columns: ['sentence1', 'sentence2', 'labels'],
      rows: [
        [
          ['sentence1', ['q1', 'q2']],
          ['sentence2', ['d1', 'd2']],
          ['labels', [1, 0]],
        ],
      ],
    },
  ];

  const first = await loadDataset(options);
  const requests = server.requests().length;
  const second = await loadDataset(options);

  assert.deepEqual(splitsOf(first), expected);
  assert.deepEqual(splitsOf(second), expected);
  assert.equal(server.requests().length, requests);
});

// A task whose split data is a Dataset, as the task types other than
// retrieval are, with a transform that records what it sees.
class SubsetTask extends AbsTask<Dataset> {
  seenByTransform: string[] = [];

  constructor(path: string) {
    super({
      metadata: new TaskMetadata({
        name: 'Subsets',
        description: 'A multilingual dataset in a folder on disk.',
        dataset: { path, revision: 'unused' },
        type: 'STS',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: new Map([
          ['de', ['deu-Latn']],
          ['en', ['eng-Latn']],
        ]),
        mainScore: 'cosine_spearman',
      }),
    });
  }

  protected override loadSplits() {
    return this.loadDatasets();
  }

  override datasetTransform(): void {
    for (const [subset, splits] of this.dataset ?? [])
      for (const [split, dataset] of splits)
        this.seenByTransform.push(`${subset}/${split}:${dataset.rows.length}`);
  }

  protected override async evaluateSubset(
    _model: MTEBModels,
  ): Promise<Record<string, Score>> {
    return {};
  }
}

test('loadData of a multilingual task loads the config of each subset with all its splits, then runs datasetTransform on them', async () => {
  await using folder = await new TemporaryFiles().directory('mteb-subsets-');
  const files: Record<string, string> = {
    'README.md': `---
configs:
- config_name: en
  data_files:
  - split: train
    path: en/train.jsonl
  - split: test
    path: en/test.jsonl
- config_name: de
  data_files:
  - split: test
    path: de/*.jsonl
---
`,
    'en/train.jsonl': jsonl([{ sentence1: 'a', score: 1 }]),
    'en/test.jsonl': jsonl([
      { sentence1: 'b', score: 2 },
      { sentence1: 'c', score: 3 },
    ]),
    'de/b.jsonl': jsonl([{ sentence1: 'e', score: 5 }]),
    'de/a.jsonl': jsonl([{ sentence1: 'd', score: 4 }]),
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(folder.path, path)), { recursive: true });
    await writeFile(join(folder.path, path), text);
  }
  const task = new SubsetTask(folder.path);

  await task.loadData();

  assert.deepEqual(task.seenByTransform, [
    'de/test:2',
    'en/train:1',
    'en/test:2',
  ]);
  assert.deepEqual(task.dataset?.get('de')?.get('test')?.rows, [
    { sentence1: 'd', score: 4 },
    { sentence1: 'e', score: 5 },
  ]);
});
