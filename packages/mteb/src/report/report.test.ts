import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import type { MTEBModels } from '../abstasks/abstask.ts';
import { AbsTaskRetrieval } from '../abstasks/retrieval.ts';
import { TaskMetadata } from '../abstasks/task-metadata.ts';
import { ResultCache } from '../cache/result-cache.ts';
import { evaluate } from '../evaluate.ts';
import { bm25S } from '../models/model-implementations/bm25.ts';
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
