import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import type { MTEBModels } from '../abstasks/abstask.ts';
import { AbsTaskRetrieval } from '../abstasks/retrieval.ts';
import { TaskMetadata } from '../abstasks/task-metadata.ts';
import { ResultCache } from '../cache/result-cache.ts';
import { evaluate } from '../evaluate.ts';
import { bm25S } from '../models/model-implementations/bm25.ts';
import { ModelMeta } from '../models/model-meta.ts';
import type { SearchProtocol } from '../models/models-protocols.ts';
import { holm } from '../significance/holm.ts';
import { pairedBootstrapTest } from '../significance/paired-bootstrap.ts';
import { perQueryScores } from '../significance/per-query-scores.ts';
import { Report } from './report.ts';

// The folder dataset of the predictions fixture: 8 documents, 4 queries, the
// splits test and dev. On test, BM25 scores higher than BM25 with k1 1.2 and
// b 0.5; on dev, the two tie.
class FolderTask extends AbsTaskRetrieval {
  constructor(mainScore: string) {
    super({
      metadata: new TaskMetadata({
        name: 'ReportFixture',
        description: 'The predictions fixture of @zukhruf/mteb.',
        dataset: {
          path: join(import.meta.dirname, '../abstasks/fixtures/predictions'),
          revision: '1',
        },
        type: 'Retrieval',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test', 'dev'],
        evalLangs: ['eng-Latn'],
        mainScore,
      }),
    });
  }
}

// What a consumer has after evaluate: BM25 and BM25 with k1 1.2 and b 0.5
// (an experiment of the same model), their results in a cache and their
// predictions in a folder each.
async function evaluated(root: string, mainScore = 'ndcg_at_10') {
  const baseline = bm25S.loadModel();
  const change = bm25S.loadModel({ k1: 1.2, b: 0.5 });
  const models: MTEBModels[] = [baseline, change];
  const cache = new ResultCache(root);
  const predictionFolder = (model: MTEBModels) =>
    join(
      root,
      'predictions',
      `${model.mtebModelMeta.modelNameAsPath()}${model.mtebModelMeta.experimentName ?? ''}`,
    );
  for (const model of models)
    await evaluate(model, new FolderTask(mainScore), {
      cache,
      predictionFolder: predictionFolder(model),
    });
  return { baseline, change, models, cache, predictionFolder };
}

test('the scores table of a report is the table of MTEB of each split, with the main score and MRR@10, and without a recall at a cut-off above the size of the corpus', async () => {
  await using folder = await new TemporaryFiles().directory('mteb-report-');
  const { baseline, models, cache, predictionFolder } = await evaluated(
    folder.path,
  );
  const task = new FolderTask('ndcg_at_10');

  const report = await Report.from({
    task,
    models,
    cache,
    predictionFolder,
    baseline,
  });

  assert.deepEqual(
    report.scores,
    cache
      .loadResults({
        includeRemote: false,
        models: models.map((model) => model.mtebModelMeta),
      })
      .selectTasks([task])
      .toDataFrame({
        aggregationLevel: 'split',
        format: 'long',
        includeExperiments: true,
        scores: ['ndcg_at_10', 'mrr_at_10'],
      }),
  );
});

test('the verdicts of a report are the paired bootstrap of the per-query scores, Holm-adjusted except the primary comparison', async () => {
  await using folder = await new TemporaryFiles().directory('mteb-report-');
  const { baseline, change, models, cache, predictionFolder } = await evaluated(
    folder.path,
  );
  const task = new FolderTask('ndcg_at_10');
  const test = async (split: string, score: string) =>
    pairedBootstrapTest(
      await perQueryScores(task, predictionFolder(baseline), { split, score }),
      await perQueryScores(task, predictionFolder(change), { split, score }),
    );

  const report = await Report.from({
    task,
    models,
    cache,
    predictionFolder,
    baseline,
    tested: ['ndcg_at_10', 'recall_at_10', 'map_at_10'],
    primary: { baseline, change, score: 'ndcg_at_10' },
  });

  const expected = [];
  for (const split of ['test', 'dev']) {
    const [ndcg, recall, map] = [
      await test(split, 'ndcg_at_10'),
      await test(split, 'recall_at_10'),
      await test(split, 'map_at_10'),
    ];
    const [recallP, mapP] = holm([recall.p, map.p]);
    expected.push(
      [split, 'ndcg_at_10', true, ndcg.observed, ndcg.p, ndcg.p],
      [split, 'recall_at_10', false, recall.observed, recall.p, recallP],
      [split, 'map_at_10', false, map.observed, map.p, mapP],
    );
  }
  const columns = [
    'split',
    'score',
    'primary',
    'difference',
    'p',
    'deciding_p',
  ];
  assert.deepEqual(
    report.verdicts.rows.map((row) =>
      columns.map((name) => row[report.verdicts.columns.indexOf(name)]),
    ),
    expected,
  );
  assert.deepEqual(
    [
      ...new Set(
        report.verdicts.rows.map(
          (row) => row[report.verdicts.columns.indexOf('baseline')],
        ),
      ),
    ],
    ['mteb/baseline-bm25s'],
  );
  assert.deepEqual(
    [
      ...new Set(
        report.verdicts.rows.map(
          (row) => row[report.verdicts.columns.indexOf('change')],
        ),
      ),
    ],
    ['mteb/baseline-bm25s (b_0.5__k1_1.2)'],
  );
});

test('the page of a report has a button for each split, and the sections of each split with only the first shown', async () => {
  await using folder = await new TemporaryFiles().directory('mteb-report-');
  const { baseline, models, cache, predictionFolder } = await evaluated(
    folder.path,
  );

  const html = (
    await Report.from({
      task: new FolderTask('ndcg_at_10'),
      models,
      cache,
      predictionFolder,
      baseline,
    })
  ).toHtml();

  assert.deepEqual(
    [
      ...html.matchAll(
        /<button type="button" data-split="(\d)"[^>]*>([^<]+)</g,
      ),
    ].map((match) => [match[1], match[2]]),
    [
      ['0', 'test'],
      ['1', 'dev'],
    ],
  );
  assert.deepEqual(
    [...html.matchAll(/<div class="split" data-split="(\d)"( hidden)?>/g)].map(
      (match) => [match[1], match[2] ?? ''],
    ),
    [
      ['0', ''],
      ['1', ' hidden'],
    ],
  );
  for (const claim of [
    'class="hero"',
    'More than chance?',
    'Depth · Recall@k',
    'Query by query · nDCG@10',
    'All scores',
    'How the models were tested',
  ])
    assert.equal(html.split(claim).length - 1, 2, claim);
});

test('each query row of the heatmap is one tab stop whose tooltip has the score of each model, and the scores table has the evaluation time of each model', async () => {
  await using folder = await new TemporaryFiles().directory('mteb-report-');
  const { baseline, models, cache, predictionFolder } = await evaluated(
    folder.path,
  );

  const html = (
    await Report.from({
      task: new FolderTask('ndcg_at_10'),
      models,
      cache,
      predictionFolder,
      baseline,
    })
  ).toHtml();

  const rows = [
    ...html.matchAll(/<div class="heat-row" tabindex="0" data-tip="([^"]+)"/g),
  ].map((match) =>
    JSON.parse(
      (match[1] ?? '').replace(/&#(\d+);/g, (_, code: string) =>
        String.fromCharCode(Number(code)),
      ),
    ),
  );
  assert.equal(rows.length, 4);
  for (const row of rows)
    assert.deepEqual(
      row.rows.map(([, name]: [string, string]) => name).toSorted(),
      ['mteb/baseline-bm25s', 'mteb/baseline-bm25s (b_0.5__k1_1.2)'],
    );
  assert.equal(
    html.split('<th scope="col">Evaluation time, all splits</th>').length - 1,
    2,
  );
  assert.match(html, /<td>\d+\.\d s<\/td>/);
});

test('predictions of another run are refused, with the model, the split and the way to write them again', async () => {
  await using folder = await new TemporaryFiles().directory('mteb-report-');
  const { baseline, change, models, cache, predictionFolder } = await evaluated(
    folder.path,
  );
  copyFileSync(
    join(predictionFolder(change), 'ReportFixture_predictions.json'),
    join(predictionFolder(baseline), 'ReportFixture_predictions.json'),
  );

  await assert.rejects(
    Report.from({
      task: new FolderTask('ndcg_at_10'),
      models,
      cache,
      predictionFolder,
      baseline,
    }),
    {
      message: new RegExp(
        `^The predictions of mteb/baseline-bm25s in ${predictionFolder(baseline).replaceAll('.', '\\.')} do not match its result on test \\(subset default\\): the ndcg_at_10 of their queries averages 0\\.53\\d*, and the result has 0\\.71534\\. They come from another run, or the qrels changed after the run\\.`,
      ),
    },
  );
});

test('a model whose predictions are missing is refused with its folder and the way to write them', async () => {
  await using folder = await new TemporaryFiles().directory('mteb-report-');
  const { baseline, change, models, cache, predictionFolder } = await evaluated(
    folder.path,
  );
  rmSync(predictionFolder(change), { recursive: true });

  await assert.rejects(
    Report.from({
      task: new FolderTask('ndcg_at_10'),
      models,
      cache,
      predictionFolder,
      baseline,
    }),
    {
      message: `mteb/baseline-bm25s (b_0.5__k1_1.2) has no predictions in ${predictionFolder(change)}. Run evaluate with predictionFolder set to this folder and overwriteStrategy 'always': a result read from the cache writes no predictions.`,
    },
  );
});

test('a baseline that is not one of the models is refused', async () => {
  await using folder = await new TemporaryFiles().directory('mteb-report-');
  const { change, cache, predictionFolder } = await evaluated(folder.path);

  await assert.rejects(
    Report.from({
      task: new FolderTask('ndcg_at_10'),
      models: [change],
      cache,
      predictionFolder,
      baseline: bm25S.loadModel(),
    }),
    {
      name: 'RangeError',
      message: 'The baseline mteb/baseline-bm25s is not one of models.',
    },
  );
});

test('when the baseline scores highest, the page compares the best other model with it', async () => {
  await using folder = await new TemporaryFiles().directory('mteb-report-');
  const { baseline, models, cache, predictionFolder } = await evaluated(
    folder.path,
  );

  const html = (
    await Report.from({
      task: new FolderTask('ndcg_at_10'),
      models,
      cache,
      predictionFolder,
      baseline,
    })
  ).toHtml();
  const test = html.slice(0, html.indexOf('<div class="split" data-split="1"'));

  assert.match(
    test,
    /the baseline scores 0\.715 nDCG@10\. The best other model, mteb\/baseline-bm25s \(b_0\.5__k1_1\.2\), scores 0\.531\./,
  );
  assert.match(
    test,
    /mteb\/baseline-bm25s \(b_0\.5__k1_1\.2\) beats the baseline on \d+ of 2 queries/,
  );
  assert.doesNotMatch(test, /mteb\/baseline-bm25s beats the baseline/);
});

test('models that share the best score tie on the page, and none of them leads', async () => {
  await using folder = await new TemporaryFiles().directory('mteb-report-');
  const { baseline, models, cache, predictionFolder } = await evaluated(
    folder.path,
  );

  const html = (
    await Report.from({
      task: new FolderTask('ndcg_at_10'),
      models,
      cache,
      predictionFolder,
      baseline,
    })
  ).toHtml();
  const dev = html.slice(html.indexOf('<div class="split" data-split="1"'));

  assert.match(
    dev,
    /<h1>mteb\/baseline-bm25s and mteb\/baseline-bm25s \(b_0\.5__k1_1\.2\) tie for the highest nDCG@10<\/h1>/,
  );
  assert.match(
    dev,
    /<h2>mteb\/baseline-bm25s and mteb\/baseline-bm25s \(b_0\.5__k1_1\.2\) tie on nDCG@10 and MRR@10\.<\/h2>/,
  );
});

test('a main score without a value for each query, such as MRR@10, gives way to nDCG@10 for the queries and the verdicts', async () => {
  await using folder = await new TemporaryFiles().directory('mteb-report-');
  const { baseline, models, cache, predictionFolder } = await evaluated(
    folder.path,
    'mrr_at_10',
  );

  const report = await Report.from({
    task: new FolderTask('mrr_at_10'),
    models,
    cache,
    predictionFolder,
    baseline,
  });

  assert.equal(report.toHtml().split('Query by query · nDCG@10').length - 1, 2);
  assert.deepEqual(
    [
      ...new Set(
        report.verdicts.rows.map(
          (row) => row[report.verdicts.columns.indexOf('score')],
        ),
      ),
    ],
    ['ndcg_at_10'],
  );
});

// Writes the files of a folder dataset: its card and its JSON Lines files.
function writeDataset(root: string, files: Readonly<Record<string, string>>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const lines = (rows: readonly object[]) =>
  rows.map((row) => JSON.stringify(row)).join('\n');

test('a task with two subsets has a split and subset in its switch, its tables and its verdicts, each with the numbers of that subset', async () => {
  await using folder = await new TemporaryFiles().directory('mteb-report-');
  const data = join(folder.path, 'data');
  const corpus = (texts: readonly string[]) =>
    lines(
      texts.map((text, index) => ({ _id: `d${index + 1}`, title: '', text })),
    );
  const queries = (texts: readonly string[]) =>
    lines(texts.map((text, index) => ({ _id: `q${index + 1}`, text })));
  const qrels = lines(
    [
      ['q1', 'd1', 2],
      ['q2', 'd4', 2],
      ['q2', 'd3', 1],
      ['q3', 'd6', 2],
    ].map(([query, document, score]) => ({
      'query-id': query,
      'corpus-id': document,
      score,
    })),
  );
  const card = ['first', 'second']
    .flatMap((subset) => [
      `  - config_name: ${subset}-corpus\n    data_files:\n      - split: corpus\n        path: ${subset}/corpus.jsonl`,
      `  - config_name: ${subset}-queries\n    data_files:\n      - split: queries\n        path: ${subset}/queries.jsonl`,
      `  - config_name: ${subset}-qrels\n    data_files:\n      - split: test\n        path: ${subset}/qrels.jsonl`,
    ])
    .join('\n');
  writeDataset(data, {
    'README.md': `---\nconfigs:\n${card}\n---\n`,
    'first/corpus.jsonl': corpus([
      'apple pie recipe with cinnamon',
      'banana bread for breakfast',
      'car engine repair at home',
      'electric car battery charging',
      'football match on sunday',
      'tennis racket strings',
    ]),
    'first/queries.jsonl': queries(['apple recipe', 'car battery', 'tennis']),
    'first/qrels.jsonl': qrels,
    'second/corpus.jsonl': corpus([
      'plum cake with almonds',
      'porridge for breakfast',
      'bicycle chain repair',
      'electric bicycle battery range',
      'rugby match on saturday',
      'badminton racket grip',
    ]),
    'second/queries.jsonl': queries([
      'plum cake',
      'bicycle battery',
      'badminton racket',
    ]),
    'second/qrels.jsonl': qrels,
  });
  class TwoSubsets extends AbsTaskRetrieval {
    constructor() {
      super({
        metadata: new TaskMetadata({
          name: 'TwoSubsets',
          description: 'Two subsets of one task.',
          dataset: { path: data, revision: '1' },
          type: 'Retrieval',
          category: 't2t',
          modalities: ['text'],
          evalSplits: ['test'],
          evalLangs: new Map([
            ['first', ['eng-Latn']],
            ['second', ['eng-Latn']],
          ]),
          mainScore: 'ndcg_at_10',
        }),
      });
    }
  }
  const baseline = bm25S.loadModel();
  const models: MTEBModels[] = [baseline, bm25S.loadModel({ k1: 1.2, b: 0.5 })];
  const cache = new ResultCache(folder.path);
  const predictionFolder = (model: MTEBModels) =>
    join(
      folder.path,
      'predictions',
      `${model.mtebModelMeta.modelNameAsPath()}${model.mtebModelMeta.experimentName ?? ''}`,
    );
  for (const model of models)
    await evaluate(model, new TwoSubsets(), {
      cache,
      predictionFolder: predictionFolder(model),
    });

  const report = await Report.from({
    task: new TwoSubsets(),
    models,
    cache,
    predictionFolder,
    baseline,
  });

  assert.deepEqual(
    [
      ...report
        .toHtml()
        .matchAll(/<button type="button" data-split="\d"[^>]*>([^<]+)</g),
    ].map((match) => match[1]),
    ['test · first', 'test · second'],
  );
  assert.deepEqual(
    report.scores,
    cache
      .loadResults({
        includeRemote: false,
        models: models.map((model) => model.mtebModelMeta),
      })
      .selectTasks([new TwoSubsets()])
      .toDataFrame({
        aggregationLevel: 'subset',
        format: 'long',
        includeExperiments: true,
        scores: ['ndcg_at_10', 'mrr_at_10'],
      }),
  );
  assert.deepEqual(
    report.verdicts.rows.map((row) => [
      row[report.verdicts.columns.indexOf('split')],
      row[report.verdicts.columns.indexOf('subset')],
    ]),
    [
      ['test', 'first'],
      ['test', 'second'],
    ],
  );
});

// A search that gives the documents in the order of the corpus, or in the
// reverse order; it reads no query, so a conversation does not stop it.
class InOrder implements SearchProtocol {
  readonly mtebModelMeta: ModelMeta;
  readonly #reverse: boolean;
  #ids: string[] = [];

  constructor(reverse: boolean) {
    this.#reverse = reverse;
    this.mtebModelMeta = ModelMeta.createEmpty({
      name: reverse ? 'zukhruf/reverse-order' : 'zukhruf/corpus-order',
      revision: '1',
    });
  }

  async index(corpus: readonly { readonly id: string }[]): Promise<void> {
    const ids = corpus.map(({ id }) => id);
    this.#ids = this.#reverse ? ids.toReversed() : ids;
  }

  async search(
    queries: readonly { readonly id: string }[],
  ): Promise<Map<string, Map<string, number>>> {
    return new Map(
      queries.map(({ id }) => [
        id,
        new Map(this.#ids.map((document, rank) => [document, 1 / (rank + 1)])),
      ]),
    );
  }
}

test('a query that is a conversation shows by its id only', async () => {
  await using folder = await new TemporaryFiles().directory('mteb-report-');
  const data = join(folder.path, 'data');
  writeDataset(data, {
    'README.md':
      '---\nconfigs:\n  - config_name: default\n    data_files:\n      - split: test\n        path: qrels/test.jsonl\n  - config_name: corpus\n    data_files:\n      - split: corpus\n        path: corpus.jsonl\n  - config_name: queries\n    data_files:\n      - split: queries\n        path: queries.jsonl\n---\n',
    'corpus.jsonl': lines(
      ['apple pie', 'car battery', 'tennis racket'].map((text, index) => ({
        _id: `d${index + 1}`,
        title: '',
        text,
      })),
    ),
    'queries.jsonl': lines([
      { _id: 'q1', text: [{ role: 'user', content: 'a pie with apples' }] },
      { _id: 'q2', text: 'a battery for a car' },
    ]),
    'qrels/test.jsonl': lines([
      { 'query-id': 'q1', 'corpus-id': 'd1', score: 1 },
      { 'query-id': 'q2', 'corpus-id': 'd2', score: 1 },
    ]),
  });
  class Conversations extends AbsTaskRetrieval {
    constructor() {
      super({
        metadata: new TaskMetadata({
          name: 'Conversations',
          description: 'A task with a conversation query.',
          dataset: { path: data, revision: '1' },
          type: 'Retrieval',
          category: 't2t',
          modalities: ['text'],
          evalSplits: ['test'],
          evalLangs: ['eng-Latn'],
          mainScore: 'ndcg_at_10',
        }),
      });
    }
  }
  const baseline = new InOrder(false);
  const models: MTEBModels[] = [baseline, new InOrder(true)];
  const cache = new ResultCache(folder.path);
  const predictionFolder = (model: MTEBModels) =>
    join(folder.path, 'predictions', model.mtebModelMeta.modelNameAsPath());
  for (const model of models)
    await evaluate(model, new Conversations(), {
      cache,
      predictionFolder: predictionFolder(model),
    });

  const html = (
    await Report.from({
      task: new Conversations(),
      models,
      cache,
      predictionFolder,
      baseline,
    })
  ).toHtml();

  assert.match(html, /<span class="q-id">q1<\/span><\/span>/);
  assert.match(
    html,
    /<span class="q-id">q2<\/span>a battery for a car<\/span>/,
  );
  assert.match(html, /data-tip="\{&#34;title&#34;:&#34;q1&#34;,/);
});

test('the example writes the report of two BM25 models on the BM25 fixture and prints the path of its page', async () => {
  await using folder = await new TemporaryFiles().directory('mteb-report-');
  const root = join(import.meta.dirname, '../..');

  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['examples/report.ts', folder.path],
    { cwd: root },
  );

  const page = join(folder.path, 'report.html');
  assert.equal(stdout.trim().split('\n').at(-1), page);
  assert.ok(existsSync(page));
  assert.match(readFileSync(page, 'utf8'), /<title>Bm25Fixture<\/title>/);
});
