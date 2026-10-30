import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';
import { HttpServer } from '@zukhruf/testing/http';

import type { HubOptions } from '../dependencies/datasets.ts';
import { AbsTaskRetrieval } from './retrieval.ts';
import { TaskMetadata } from './task-metadata.ts';

// A task of a project's own, whose dataset is a folder on disk, as a host
// keeps its labelled dataset beside its code.
class FolderTask extends AbsTaskRetrieval {
  constructor(options: {
    readonly path: string;
    readonly revision: string;
    readonly hub: HubOptions;
  }) {
    super({
      metadata: new TaskMetadata({
        name: 'Folder',
        description: 'A dataset in a folder on disk.',
        dataset: { path: options.path, revision: options.revision },
        type: 'Retrieval',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['dev'],
        evalLangs: ['eng-Latn'],
        mainScore: 'ndcg_at_10',
      }),
      hub: options.hub,
    });
  }
}

const jsonl = (rows: readonly object[]) =>
  rows.map((row) => JSON.stringify(row)).join('\n');

async function write(
  folder: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), text);
  }
}

// The HuggingFace Hub cannot be reached in CI. This server stands in for it
// and answers nothing but 404, so a test can count what a load asks for.
async function hub(): Promise<{
  readonly origin: string;
  readonly requests: () => readonly string[];
  [Symbol.asyncDispose](): Promise<void>;
}> {
  const requests: string[] = [];
  const server = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '');
    response.statusCode = 404;
    response.end('Not found');
  });
  return {
    origin: server.origin,
    requests: () => [...requests],
    [Symbol.asyncDispose]: () => server.cleanup(),
  };
}

test('a dataset in a folder is read from its files at each load, so an edited label counts, and nothing goes into the dataset cache', async () => {
  await using server = await hub();
  await using cache = await new TemporaryFiles().directory('mteb-datasets-');
  await using folder = await new TemporaryFiles().directory('mteb-folder-');
  await write(folder.path, {
    'README.md': `---
configs:
  - config_name: default
    data_files:
      - split: dev
        path: qrels/dev.jsonl
  - config_name: corpus
    data_files:
      - split: corpus
        path: corpus.jsonl
  - config_name: queries
    data_files:
      - split: queries
        path: queries.jsonl
---
`,
    'corpus.jsonl': jsonl([
      { _id: 'p1', title: 'Ada', text: 'Led a health system reform.' },
      { _id: 'p2', title: 'Ben', text: 'Taught teachers.' },
    ]),
    'queries.jsonl': jsonl([{ _id: 'q1', text: 'Who reformed health?' }]),
    'qrels/dev.jsonl': jsonl([
      { 'query-id': 'q1', 'corpus-id': 'p1', score: 2 },
    ]),
  });
  const options = {
    path: folder.path,
    revision: '1',
    hub: { endpoint: server.origin, cacheFolder: cache.path },
  };
  await new FolderTask(options).loadData();
  await write(folder.path, {
    'qrels/dev.jsonl': jsonl([
      { 'query-id': 'q1', 'corpus-id': 'p1', score: 2 },
      { 'query-id': 'q1', 'corpus-id': 'p2', score: 1 },
    ]),
  });

  const task = new FolderTask(options);
  await task.loadData();

  assert.deepEqual(
    task.dataset?.get('default')?.get('dev')?.relevantDocs,
    new Map([
      [
        'q1',
        new Map([
          ['p1', 2],
          ['p2', 1],
        ]),
      ],
    ]),
  );
  assert.deepEqual(await readdir(cache.path), []);
});

test('a dataset in a folder loads the files that its card names, at any revision, and asks the Hub nothing', async () => {
  await using server = await hub();
  await using cache = await new TemporaryFiles().directory('mteb-datasets-');
  await using folder = await new TemporaryFiles().directory('mteb-folder-');
  await write(folder.path, {
    'README.md': `---
configs:
  - config_name: default
    data_files:
      - split: dev
        path: labels/dev.jsonl
      - split: test
        path: labels/test.jsonl
  - config_name: corpus
    data_files:
      - split: corpus
        path: data/people.jsonl
  - config_name: queries
    data_files:
      - split: queries
        path: data/asks.jsonl
---
`,
    'data/people.jsonl': jsonl([
      { _id: 'p1', title: 'Ada', text: 'Led a health system reform.' },
      { _id: 7, title: 'Ben', text: 'Taught teachers.' },
    ]),
    'data/asks.jsonl': jsonl([
      { _id: 'q1', text: 'Who reformed health?' },
      { _id: 'q2', text: 'Who trained teachers?' },
    ]),
    'labels/dev.jsonl': jsonl([
      { 'query-id': 'q1', 'corpus-id': 'p1', score: 2 },
      { 'query-id': 'q1', 'corpus-id': 7, score: 0 },
    ]),
    'labels/test.jsonl': jsonl([
      { 'query-id': 'q2', 'corpus-id': 7, score: 2 },
    ]),
    // Files at the names a loader could guess; the card names none of them.
    'corpus.jsonl': jsonl([{ _id: 'x', title: 'X', text: 'Not the corpus.' }]),
    'queries.jsonl': jsonl([{ _id: 'q1', text: 'Not the query.' }]),
    'qrels/dev.jsonl': jsonl([
      { 'query-id': 'q1', 'corpus-id': 'x', score: 1 },
    ]),
  });
  const task = new FolderTask({
    path: folder.path,
    revision: 'a-revision-the-hub-does-not-have',
    hub: { endpoint: server.origin, cacheFolder: cache.path },
  });

  await task.loadData();

  const split = task.dataset?.get('default')?.get('dev');
  assert.deepEqual(split?.corpus, [
    { title: 'Ada', text: 'Led a health system reform.', id: 'p1' },
    { title: 'Ben', text: 'Taught teachers.', id: '7' },
  ]);
  assert.deepEqual(split?.queries, [
    { text: 'Who reformed health?', id: 'q1' },
  ]);
  assert.deepEqual(
    split?.relevantDocs,
    new Map([
      [
        'q1',
        new Map([
          ['p1', 2],
          ['7', 0],
        ]),
      ],
    ]),
  );
  assert.deepEqual(server.requests(), []);
});
