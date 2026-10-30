import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { EmbeddingModelV4 } from '@ai-sdk/provider';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import type { Dataset } from '../dependencies/datasets.ts';
import {
  type FittedLinearRegression,
  LinearRegression,
} from '../dependencies/sklearn-linear-regression.ts';
import { evaluate } from '../evaluate.ts';
import { valuesOf } from '../evaluators/sklearn-evaluator.ts';
import { AiSdkEncoder } from '../models/ai-sdk-encoder.ts';
import { ModelMeta } from '../models/model-meta.ts';
import { pythonJsonLoads } from '../results/json.ts';
import { RuSciBenchCitedCountRegression } from '../tasks/regression/multilingual/ru-sci-bench-regression.ts';
import type { Embeddings } from '../types/encoder-io.ts';
import { AbsTaskRegression } from './regression.ts';
import { TaskMetadata } from './task-metadata.ts';

// fixtures/regression/expected.json holds what Python MTEB 2.26.28
// (scikit-learn 1.9.1, scipy 1.18.1, numpy 2.5.4, pandas 3.1.0, datasets
// 5.1.0) on macOS arm64 gave for two folder tasks (fixtures/regression/folder,
// with all its training rows, and subsampled, whose task keeps 100 training
// rows in each experiment) with an encoder that reads each text as a vector,
// and for RuSciBenchCitedCountRegression on a slice of its data
// (fixtures/regression/hub, in the cache layout of dependencies/datasets.ts)
// with an encoder that counts code points: the undersampling of each
// experiment, the split, number and sha256 of the texts of each call of the
// encoder, the scores of mteb.evaluate, the predictions file that it wrote,
// coef_ and intercept_ of each fit, and the scores of a second
// mteb.evaluate. It also holds the errors of two folder tasks (few-train and
// one-member) and the rows of stratified_subsampling of four test splits.
// generate.py makes it.
//
// LinearRegression solves its least squares with the float32 sgelsd of
// Accelerate, whose order of operations no port can copy, so the
// coefficients, the predictions and the scores that come from their values
// are within 1e-4 of their size. The order of the predictions, and thus
// kendalltau and the main score, are equal.
const FOLDER = join(import.meta.dirname, 'fixtures/regression');
const TOLERANCE = 1e-4;

type EncoderCall = {
  readonly hf_split: string;
  readonly count: number;
  readonly sha256: string;
};

type Scores = Record<string, unknown> & {
  readonly scores_per_experiment: readonly Record<string, number>[];
};

type Run = {
  readonly undersampling: Readonly<Record<string, number[][]>>;
  readonly encoder_calls: readonly EncoderCall[];
  readonly scores: { readonly test: Scores[] };
  readonly predictions: Readonly<Record<string, unknown>>;
  readonly fits: readonly {
    readonly coef: number[];
    readonly intercept: number;
  }[];
  readonly second_scores: { readonly test: Scores[] };
};

type Expected = {
  readonly code_point_dim: number;
  readonly folder: Run;
  readonly subsampled: Run;
  readonly hub: Run;
  readonly few_train_error: string;
  readonly one_member_error: string;
  readonly stratified_subsampling: readonly {
    readonly case: string;
    readonly values: number[];
    readonly n_samples: number;
    readonly seed: number;
    readonly rows?: Record<string, unknown>[];
    readonly error?: string;
  }[];
};

const expected: Expected = JSON.parse(
  readFileSync(join(FOLDER, 'expected.json'), 'utf8'),
);

// A LinearRegression that keeps each fitted model.
class RecordingLinearRegression extends LinearRegression {
  readonly fits: FittedLinearRegression[] = [];

  override fit(x: Embeddings, y: readonly number[]) {
    const fitted = super.fit(x, y);
    this.fits.push(fitted);
    return fitted;
  }
}

// The undersampling of each experiment, as generate.py calls it, and the
// scores of given predictions.
class FolderTask extends AbsTaskRegression {
  override evaluatorModel = new RecordingLinearRegression();

  constructor(name: string, folder: string, nSamples = 2048) {
    super({
      metadata: new TaskMetadata({
        name,
        description: 'The regression fixture of @zukhruf/mteb.',
        dataset: { path: join(FOLDER, folder), revision: '1' },
        type: 'Regression',
        category: 't2c',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'kendalltau',
      }),
    });
    this.nSamples = nSamples;
  }

  experiments(train: Dataset) {
    return Array.from(
      { length: this.nExperiments },
      (_, i) => this.undersampleData(train, i, null).selected,
    );
  }

  scores(yTest: readonly number[], yPred: Float32Array) {
    return this.calculateScores(yTest, yPred);
  }
}

// The Hub slice of generate.py, read from the cache. An endpoint that
// refuses connections fails the test if the task reaches for the network.
class CitedCountSlice extends RuSciBenchCitedCountRegression {
  override evaluatorModel = new RecordingLinearRegression();

  constructor() {
    super({
      hub: {
        cacheFolder: join(FOLDER, 'hub'),
        endpoint: 'http://127.0.0.1:9',
      },
    });
    this.nSamples = 120;
  }

  experiments(train: Dataset) {
    return Array.from(
      { length: this.nExperiments },
      (_, i) => this.undersampleData(train, i, null).selected,
    );
  }

  scores(yTest: readonly number[], yPred: Float32Array) {
    return this.calculateScores(yTest, yPred);
  }
}

const TASKS = [
  ['folder', () => new FolderTask('RegressionFixture', 'folder')],
  [
    'subsampled',
    () => new FolderTask('SubsampledRegressionFixture', 'subsampled', 100),
  ],
  ['hub', () => new CitedCountSlice()],
] as const;

type Name = (typeof TASKS)[number][0];

// An encoder whose calls the test reads back.
function recordingEncoder(
  name: string,
  embed: (text: string) => number[],
): { readonly encoder: AiSdkEncoder; readonly calls: EncoderCall[] } {
  const calls: EncoderCall[] = [];
  const model: EmbeddingModelV4 = {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: name,
    maxEmbeddingsPerCall: undefined,
    supportsParallelCalls: true,
    async doEmbed({ values }) {
      return {
        embeddings: values.map(embed),
        usage: { tokens: values.length },
        warnings: [],
      };
    },
  };
  const encoder = new AiSdkEncoder({
    model,
    modelMeta: ModelMeta.createEmpty({ name: `test/${name}`, revision: '1' }),
  });
  const encode = encoder.encode.bind(encoder);
  encoder.encode = async (inputs, options) => {
    const texts = inputs.flatMap((batch) => batch.text);
    calls.push({
      hf_split: options.hfSplit,
      count: texts.length,
      sha256: createHash('sha256').update(texts.join('\0')).digest('hex'),
    });
    return encode(inputs, options);
  };
  return { encoder, calls };
}

// The vector encoder of generate.py.
const embedVector = (text: string) => text.split(' ').map(Number);

// The code point count encoder of generate.py.
function embedCodePointCounts(text: string): number[] {
  const vector = new Array<number>(expected.code_point_dim).fill(0);
  for (const character of text) {
    const k = (character.codePointAt(0) ?? 0) % expected.code_point_dim;
    vector[k] = (vector[k] ?? 0) + 1;
  }
  return vector;
}

const embedOf = (name: Name) =>
  name === 'hub' ? embedCodePointCounts : embedVector;

const encoderOf = (name: Name) =>
  recordingEncoder(
    name === 'hub' ? 'code-point-counts' : 'vector',
    embedOf(name),
  );

// The test split of each subset of a loaded task, in the order of its
// subsets.
function testSplits(task: AbsTaskRegression): [string, Dataset][] {
  return task.hfSubsets.map((subset) => {
    const split = task.dataset?.get(subset)?.get('test');
    assert.ok(split);
    return [subset, split];
  });
}

// The predictions of each experiment of a subset in a predictions file.
function predictionsOf(file: unknown, subset: string): number[][] {
  assert.ok(typeof file === 'object' && file !== null);
  const splits: unknown = Object.entries(file).find(
    ([key]) => key === subset,
  )?.[1];
  assert.ok(typeof splits === 'object' && splits !== null);
  const test: unknown = Object.entries(splits).find(
    ([key]) => key === 'test',
  )?.[1];
  assert.ok(Array.isArray(test));
  return test;
}

// The stable order of predictions.
const orderOf = (values: readonly number[]) =>
  values
    .map((value, index) => [value, index] as const)
    .sort(([a, i], [b, j]) => a - b || i - j)
    .map(([, index]) => index);

const relativeDifference = (actual: number, value: number) =>
  Math.abs(actual - value) / Math.max(1, Math.abs(value));

// The scores that come from the values of the predictions.
const CLOSE_SCORES: readonly string[] = ['mse', 'mae', 'r2', 'rmse'];

// The scores of a subset without CLOSE_SCORES, with the order of the keys.
function exactScores(scores: Scores) {
  return {
    ...Object.fromEntries(
      Object.entries(scores).filter(([key]) => !CLOSE_SCORES.includes(key)),
    ),
    keys: Object.keys(scores),
    scores_per_experiment: scores.scores_per_experiment.map((experiment) => ({
      kendalltau: experiment['kendalltau'],
      keys: Object.keys(experiment),
    })),
  };
}

// The largest relative difference of CLOSE_SCORES, of the mean and of each
// experiment.
function closeScoresDifference(actual: Scores, python: Scores): number {
  let largest = 0;
  for (const key of CLOSE_SCORES) {
    largest = Math.max(
      largest,
      relativeDifference(Number(actual[key]), Number(python[key])),
    );
    for (const [i, experiment] of python.scores_per_experiment.entries())
      largest = Math.max(
        largest,
        relativeDifference(
          actual.scores_per_experiment[i]?.[key] ?? Number.NaN,
          experiment[key] ?? Number.NaN,
        ),
      );
  }
  return largest;
}

// What evaluate gives a task with the encoder of its name, and the
// predictions file that it writes.
async function evaluated(name: Name, task: AbsTaskRegression) {
  await using folder = await new TemporaryFiles().directory(
    'regression-predictions-',
  );
  const { encoder, calls } = encoderOf(name);
  const result = await evaluate(encoder, task, {
    cache: null,
    predictionFolder: folder.path,
  });
  const file = pythonJsonLoads(
    readFileSync(
      join(folder.path, `${task.metadata.name}_predictions.json`),
      'utf8',
    ),
  );
  const scores = (result.taskResults[0]?.scores['test'] ?? []).map(
    (subset): Scores => {
      const perExperiment = subset['scores_per_experiment'];
      assert.ok(Array.isArray(perExperiment));
      return { ...subset, scores_per_experiment: perExperiment };
    },
  );
  return { calls, scores, file };
}

for (const [name, makeTask] of TASKS)
  test(`the undersampling of each experiment of ${name} equals MTEB's: all the rows, or the stratified subsampling with the seed of the experiment`, async () => {
    const task = makeTask();
    await task.loadData();

    const experiments = Object.fromEntries(
      task.hfSubsets.map((subset) => {
        const train = task.dataset?.get(subset)?.get('train');
        assert.ok(train);
        return [subset, task.experiments(train)];
      }),
    );

    assert.deepEqual(experiments, expected[name].undersampling);
  });

for (const [name, makeTask] of TASKS)
  test(`evaluate gives ${name} the encoder inputs of MTEB, its predictions in the same order, and its kendalltau and main score to the last bit`, async () => {
    const task = makeTask();

    const { calls, scores, file } = await evaluated(name, task);

    const orders = (predictions: unknown) =>
      task.hfSubsets.map((subset) =>
        predictionsOf(predictions, subset).map(orderOf),
      );
    assert.deepEqual(
      {
        calls,
        fileKeys: Object.keys(file ?? {}),
        orders: orders(file),
        scores: scores.map(exactScores),
      },
      {
        calls: expected[name].encoder_calls,
        fileKeys: Object.keys(expected[name].predictions),
        orders: orders(expected[name].predictions),
        scores: expected[name].scores.test.map(exactScores),
      },
    );
  });

for (const [name, makeTask] of TASKS)
  test(`evaluate gives ${name} the coefficients, predictions, mse, mae, r2 and rmse of MTEB within 1e-4 of their size`, async () => {
    const task = makeTask();

    const { scores, file } = await evaluated(name, task);

    // evaluate unloads the data of the task.
    await task.loadData();
    const embed = embedOf(name);
    const fits = expected[name].fits;
    const differences = { coef: 0, intercept: 0, predictions: 0, scores: 0 };
    for (const [s, [subset, split]] of testSplits(task).entries()) {
      const xTest = split.rows.map((row) => embed(String(row['text'])));
      const actual = predictionsOf(file, subset);
      for (const [i, python] of predictionsOf(
        expected[name].predictions,
        subset,
      ).entries()) {
        const fit = fits[s * task.nExperiments + i];
        const model = task.evaluatorModel.fits[s * task.nExperiments + i];
        assert.ok(fit && model);
        for (const [j, c] of fit.coef.entries())
          differences.coef = Math.max(
            differences.coef,
            relativeDifference(model.coef[j] ?? Number.NaN, c),
          );
        differences.intercept = Math.max(
          differences.intercept,
          relativeDifference(model.intercept, fit.intercept),
        );
        for (const [j, value] of python.entries()) {
          const row = xTest[j] ?? [];
          const size = fit.coef.reduce(
            (total, c, k) => total + Math.abs((row[k] ?? 0) * c),
            Math.abs(fit.intercept),
          );
          differences.predictions = Math.max(
            differences.predictions,
            Math.abs((actual[i]?.[j] ?? Number.NaN) - value) /
              Math.max(1, size),
          );
        }
      }
    }
    for (const [i, score] of scores.entries()) {
      const python = expected[name].scores.test[i];
      assert.ok(python);
      differences.scores = Math.max(
        differences.scores,
        closeScoresDifference(score, python),
      );
    }
    assert.equal(fits.length, task.evaluatorModel.fits.length);
    assert.ok(
      Object.values(differences).every((value) => value <= TOLERANCE),
      JSON.stringify(differences),
    );
  });

for (const [name, makeTask] of TASKS)
  test(`the scores of the predictions of MTEB for ${name} equal MTEB's scores to the last bit`, async () => {
    const task = makeTask();
    await task.loadData();

    const actual = testSplits(task).map(([subset, split]) =>
      predictionsOf(expected[name].predictions, subset).map((predictions) =>
        task.scores(valuesOf(split, 'value'), Float32Array.from(predictions)),
      ),
    );

    assert.deepEqual(
      actual,
      expected[name].scores.test.map((score) => score.scores_per_experiment),
    );
  });

for (const [name, makeTask] of TASKS)
  test(`a second evaluate of the same ${name} task gives the scores of the first one, as MTEB does: the subsampling draws from new generators`, async () => {
    const task = makeTask();
    const first = await evaluated(name, task);

    const second = await evaluated(name, task);

    assert.deepEqual(second.scores, first.scores);
  });

test('a training split of fewer rows than nSamples plus the bins throws the error of MTEB', async () => {
  const task = new FolderTask('FewTrainRegressionFixture', 'few-train', 100);

  await assert.rejects(
    evaluate(encoderOf('folder').encoder, task, { cache: null }),
    { message: expected.few_train_error },
  );
});

test('a bin of one training row throws the error of MTEB', async () => {
  const task = new FolderTask('OneMemberRegressionFixture', 'one-member', 100);

  await assert.rejects(
    evaluate(encoderOf('folder').encoder, task, { cache: null }),
    { message: expected.one_member_error },
  );
});

test('stratifiedSubsampling gives the rows of MTEB in their order, all the rows for nSamples at least the rows, and the error of pyarrow for a constant value', () => {
  const actual = expected.stratified_subsampling.map((kase) => {
    const dataset: Dataset = {
      columnNames: ['text', 'value'],
      rows: kase.values.map((value, i) => ({ text: `row ${i}`, value })),
    };
    try {
      const result = AbsTaskRegression.stratifiedSubsampling(
        new Map([['test', dataset]]),
        { seed: kase.seed, nSamples: kase.n_samples },
      );
      return { case: kase.case, rows: result.get('test')?.rows };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { case: kase.case, error: error.message };
    }
  });

  assert.deepEqual(
    actual,
    expected.stratified_subsampling.map(({ case: name, rows, error }) =>
      error === undefined ? { case: name, rows } : { case: name, error },
    ),
  );
});

test('a value that is not a number throws a TypeError', () => {
  const dataset: Dataset = {
    columnNames: ['text', 'value'],
    rows: [
      { text: 'a', value: 1 },
      { text: 'b', value: '2' },
    ],
  };

  assert.throws(
    () =>
      AbsTaskRegression.stratifiedSubsampling(new Map([['test', dataset]]), {
        seed: 42,
        nSamples: 1,
      }),
    { name: 'TypeError', message: 'A value must be a number, not 2.' },
  );
});

test("the default evaluator model is MTEB's LinearRegression, nSamples is 2048 and the values are in the column value", () => {
  const task = new RuSciBenchCitedCountRegression();

  // @ts-expect-error A regression task has no samplesPerLabel. The type
  // check of the package (nx typecheck) fails when one is added.
  const _samplesPerLabel: unknown = task.samplesPerLabel;

  assert.ok(task.evaluatorModel instanceof LinearRegression);
  assert.deepEqual(
    {
      tol: task.evaluatorModel.tol,
      nSamples: task.nSamples,
      labelColumnName: task.labelColumnName,
    },
    { tol: 1e-6, nSamples: 2048, labelColumnName: 'value' },
  );
});
