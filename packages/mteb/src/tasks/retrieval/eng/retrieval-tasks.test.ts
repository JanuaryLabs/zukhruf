import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';
import { HttpServer } from '@zukhruf/testing/http';

import { ArguAna } from './argu-ana-retrieval.ts';
import { SCIDOCS } from './scidocs-retrieval.ts';

// The metadata of each task as MTEB 2.26.28 dumps it (model_dump_json).
const MTEB_METADATA: Record<string, unknown> = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../fixtures/task-metadata.json'),
    'utf8',
  ),
);

// A dataset repository in the layout of mteb/arguana: a dataset card whose
// configs name a JSON Lines file for each split.
const FILES: Readonly<Record<string, string>> = {
  'README.md': `---
configs:
  - config_name: default
    data_files:
      - split: test
        path: qrels/test.jsonl
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
  'corpus.jsonl': [
    { _id: 'd1', title: 'Cats', text: 'Cats sleep a lot.' },
    { _id: 'd2', title: '', text: 'Dogs bark.' },
    { _id: 3, title: 'Birds', text: 'Birds fly.' },
  ]
    .map((row) => JSON.stringify(row))
    .join('\n'),
  'queries.jsonl': [
    { _id: 'q1', text: 'Do cats sleep?' },
    { _id: 'q2', text: 'Do fish swim?' },
  ]
    .map((row) => JSON.stringify(row))
    .join('\n'),
  // mteb/arguana writes the score as a string; the card declares a number.
  'qrels/test.jsonl': [
    { 'query-id': 'q1', 'corpus-id': 'd1', score: '1' },
    { 'query-id': 'q1', 'corpus-id': 3, score: 0 },
  ]
    .map((row) => JSON.stringify(row))
    .join('\n'),
};

// The HuggingFace Hub cannot be reached in CI. This server answers the
// resolve URLs of the Hub with the files above and counts the requests.
async function hub(): Promise<{
  readonly origin: string;
  readonly requests: () => string[];
  [Symbol.asyncDispose](): Promise<void>;
}> {
  const requests: string[] = [];
  const server = await new HttpServer().start((request, response) => {
    requests.push(request.url ?? '');
    const match =
      /^\/datasets\/mteb\/arguana\/resolve\/c22ab2a51041ffd869aaddef7af8d8215647e41a\/(.+)$/u.exec(
        request.url ?? '',
      );
    const file = match?.[1] === undefined ? undefined : FILES[match[1]];
    response.statusCode = file === undefined ? 404 : 200;
    response.end(file ?? 'Not found');
  });
  return {
    origin: server.origin,
    requests: () => [...requests],
    [Symbol.asyncDispose]: () => server.cleanup(),
  };
}

for (const [name, task] of [
  ['ArguAna', () => new ArguAna()],
  ['SCIDOCS', () => new SCIDOCS()],
] as const)
  test(`the metadata of ${name} is the metadata of MTEB`, () => {
    const metadata = task().metadata;

    assert.deepEqual(metadata.toDict(), MTEB_METADATA[name]);
  });

test('a task loads its split from the files that the dataset card names, and keeps only the queries with qrels', async () => {
  await using server = await hub();
  await using cache = await new TemporaryFiles().directory('mteb-datasets-');
  const task = new ArguAna({
    hub: { endpoint: server.origin, cacheFolder: cache.path },
  });

  await task.loadData();

  const split = task.dataset?.get('default')?.get('test');
  assert.deepEqual(split?.corpus, [
    { title: 'Cats', text: 'Cats sleep a lot.', id: 'd1' },
    { title: '', text: 'Dogs bark.', id: 'd2' },
    { title: 'Birds', text: 'Birds fly.', id: '3' },
  ]);
  assert.deepEqual(split?.queries, [{ text: 'Do cats sleep?', id: 'q1' }]);
  assert.deepEqual(
    split?.relevantDocs,
    new Map([
      [
        'q1',
        new Map([
          ['d1', 1],
          ['3', 0],
        ]),
      ],
    ]),
  );
  assert.equal(split?.topRanked, null);
});

test('a second load reads the files from the cache and asks the Hub nothing', async () => {
  await using server = await hub();
  await using cache = await new TemporaryFiles().directory('mteb-datasets-');
  const options = { hub: { endpoint: server.origin, cacheFolder: cache.path } };
  await new ArguAna(options).loadData();
  const asked = server.requests().length;

  await new ArguAna(options).loadData();

  assert.equal(server.requests().length, asked);
});
