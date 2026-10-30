import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { AbsTaskRetrieval } from '../abstasks/retrieval.ts';
import { TaskMetadata } from '../abstasks/task-metadata.ts';
import { percentile } from '../dependencies/numpy.ts';
import { pythonRound, pythonSum } from '../dependencies/python.ts';
import { evaluate } from '../evaluate.ts';
import { bm25S } from '../models/model-implementations/bm25.ts';
import { type ChangeVerdict, pairedBootstrapTest } from './paired-bootstrap.ts';
import { perQueryScores } from './per-query-scores.ts';

// fixtures/expected.json holds what Python MTEB 2.26.28 and NumPy 2.5.4 gave
// for the folder task of the BM25 fixture with mteb/baseline-bm25s (the
// default settings and k1=1.2, b=0.5): the main score and the ndcg_cut_10 of
// each query, and the paired bootstrap of the two in NumPy. It also holds
// the bootstrap of synthetic pairs and np.percentile of a few arrays.
// fixtures/generate.py makes it. A float that JSON cannot hold is a string.
type JsonNumber = number | string;

type Verdict = {
  readonly result: ChangeVerdict['result'];
  readonly observed: JsonNumber;
  readonly low: JsonNumber;
  readonly high: JsonNumber;
  readonly queries: number;
  readonly replicates: number;
  readonly seed: number;
};

type Run = {
  readonly main_score: number;
  readonly per_query: Readonly<Record<string, number>>;
};

type Expected = {
  readonly bm25: {
    readonly baseline: Run;
    readonly change: Run;
    readonly verdict: Verdict;
  };
  readonly synthetic: readonly {
    readonly case: string;
    readonly baseline: [string, number][];
    readonly change: [string, number][];
    readonly verdict: Verdict;
  }[];
  readonly percentiles: readonly {
    readonly sorted: number[];
    readonly q: number[];
    readonly values: number[];
  }[];
};

const expected: Expected = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/expected.json'), 'utf8'),
);

const BM25_FOLDER = join(
  import.meta.dirname,
  '../models/model-implementations/fixtures/bm25',
);

class FolderTask extends AbsTaskRetrieval {
  constructor() {
    super({
      metadata: new TaskMetadata({
        name: 'SignificanceFixture',
        description: 'The significance fixture of @zukhruf/mteb.',
        dataset: { path: BM25_FOLDER, revision: '1' },
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

function plain(verdict: Verdict): ChangeVerdict {
  const value = (number: JsonNumber) => Number(number);
  return {
    ...verdict,
    observed: value(verdict.observed),
    low: value(verdict.low),
    high: value(verdict.high),
  };
}

// Evaluates the model on the task with a folder for its predictions, and
// gives its scores and the value of each query.
async function evaluated(
  model: ReturnType<typeof bm25S.loadModel>,
  task: AbsTaskRetrieval,
) {
  await using folder = await new TemporaryFiles().directory(
    'mteb-significance-',
  );
  const result = await evaluate(model, task, {
    cache: null,
    predictionFolder: folder.path,
  });
  const scores = result.taskResults[0]?.scores['test']?.[0];
  assert.ok(scores);
  return {
    scores,
    perQuery: await perQueryScores(task, folder.path),
  };
}

// The mean of the values as the evaluation of a task takes it.
function roundedMean(values: Map<string, number>): number {
  return pythonRound(pythonSum(values.values()) / values.size, 5);
}

test('perQueryScores gives the ndcg_cut_10 of each query that MTEB gives for BM25 and for BM25 with k1 1.2 and b 0.5, to the last bit', async () => {
  const baseline = await evaluated(bm25S.loadModel(), new FolderTask());
  const change = await evaluated(
    bm25S.loadModel({ k1: 1.2, b: 0.5 }),
    new FolderTask(),
  );

  assert.deepEqual(
    {
      baseline: {
        main_score: baseline.scores['main_score'],
        per_query: Object.fromEntries(baseline.perQuery),
      },
      change: {
        main_score: change.scores['main_score'],
        per_query: Object.fromEntries(change.perQuery),
      },
    },
    { baseline: expected.bm25.baseline, change: expected.bm25.change },
  );
});

test('the paired bootstrap test of BM25 and BM25 with k1 1.2 and b 0.5 gives the interval and the result of NumPy, to the last bit', () => {
  const { baseline, change, verdict } = expected.bm25;

  const actual = pairedBootstrapTest(
    new Map(Object.entries(baseline.per_query)),
    new Map(Object.entries(change.per_query)),
  );

  assert.deepEqual(actual, plain(verdict));
});

for (const synthetic of expected.synthetic)
  test(`the paired bootstrap test of "${synthetic.case}" gives the interval and the result of NumPy, to the last bit`, () => {
    const { seed, replicates } = synthetic.verdict;

    const actual = pairedBootstrapTest(
      new Map(synthetic.baseline),
      new Map(synthetic.change),
      { seed, replicates },
    );

    assert.deepEqual(actual, plain(synthetic.verdict));
  });

test('a percentile interpolates as np.percentile, to the last bit', () => {
  const actual = expected.percentiles.map(({ sorted, q }) =>
    q.map((value) => percentile(sorted, value)),
  );

  assert.deepEqual(
    actual,
    expected.percentiles.map(({ values }) => values),
  );
});

test('a paired bootstrap test refuses a baseline and a change with different queries', () => {
  const baseline = new Map([
    ['q1', 0.5],
    ['q2', 0.25],
  ]);
  const change = new Map([
    ['q1', 0.75],
    ['q3', 0.25],
  ]);

  assert.throws(() => pairedBootstrapTest(baseline, change), {
    name: 'RangeError',
    message: /Not in both: q2, q3$/,
  });
});

test('each score with a value for each query has the mean that evaluate gives, rounded to 5 digits', async () => {
  const names = [
    'ndcg_at_10',
    'map_at_10',
    'recall_at_100',
    'precision_at_3',
    'hit_rate_at_1',
  ];
  const model = bm25S.loadModel();
  const task = new FolderTask();
  await using folder = await new TemporaryFiles().directory(
    'mteb-significance-',
  );
  const result = await evaluate(model, task, {
    cache: null,
    predictionFolder: folder.path,
  });
  const scores = result.taskResults[0]?.scores['test']?.[0];
  assert.ok(scores);

  const means = Object.fromEntries(
    await Promise.all(
      names.map(async (score) => [
        score,
        roundedMean(await perQueryScores(task, folder.path, { score })),
      ]),
    ),
  );

  assert.deepEqual(
    means,
    Object.fromEntries(names.map((score) => [score, scores[score]])),
  );
});

test('a score without a value for each query is refused', async () => {
  const task = new FolderTask();

  await assert.rejects(
    perQueryScores(task, 'predictions', { score: 'mrr_at_10' }),
    {
      name: 'RangeError',
    },
  );
});

test('perQueryScores drops the first result of each query when the task skips it, as the evaluation does', async () => {
  const task = new FolderTask();
  task.skipFirstResult = true;

  const { scores, perQuery } = await evaluated(bm25S.loadModel(), task);

  assert.notEqual(scores['main_score'], expected.bm25.baseline.main_score);
  assert.equal(roundedMean(perQuery), scores['main_score']);
});

// Query q03 ("search search engine") takes the id of its relevant document
// d24, so ignoreIdenticalIds drops a relevant document from its results.
class IdenticalIdsTask extends FolderTask {
  override ignoreIdenticalIds = true;

  override datasetTransform(): void {
    const split = this.dataset?.get('default')?.get('test');
    assert.ok(split);
    split.queries = split.queries.map((query) =>
      query.id === 'q03' ? { ...query, id: 'd24' } : query,
    );
    split.relevantDocs = new Map(
      [...split.relevantDocs].map(([query, documents]) => [
        query === 'q03' ? 'd24' : query,
        documents,
      ]),
    );
  }
}

test('perQueryScores drops a document whose id is the id of its query when the task ignores identical ids, as the evaluation does', async () => {
  const task = new IdenticalIdsTask();

  const { scores, perQuery } = await evaluated(bm25S.loadModel(), task);

  assert.notEqual(scores['main_score'], expected.bm25.baseline.main_score);
  assert.equal(roundedMean(perQuery), scores['main_score']);
});
