import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { EmbeddingModelV4 } from '@ai-sdk/provider';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { pearsonr, rankdata, spearmanr } from '../dependencies/scipy.ts';
import { evaluate } from '../evaluate.ts';
import type { STSEvaluatorScores } from '../evaluators/any-sts-evaluator.ts';
import { AiSdkEncoder } from '../models/ai-sdk-encoder.ts';
import { ModelMeta } from '../models/model-meta.ts';
import { STSBenchmarkSTS } from '../tasks/sts/eng/sts-benchmark-sts.ts';
import { AbsTaskSTS } from './sts.ts';
import { TaskMetadata } from './task-metadata.ts';

// fixtures/sts/expected.json holds what Python MTEB 2.26.28 (SciPy 1.18.1,
// scikit-learn 1.9.1, numpy 2.5.4, torch 2.14.1) gave for the folder task of
// fixtures/sts/folder with an encoder that reads each text as a vector: the
// scores of mteb.evaluate, the predictions file that it wrote and the gold
// scores that _normalize gives. It holds the same for STSBenchmark on a
// slice of its data (fixtures/sts/hub, in the cache layout of
// dependencies/datasets.ts) with an encoder that counts code points. It also
// holds the rankdata, pearsonr and spearmanr of SciPy for arrays made in
// generate.py. generate.py makes it. JSON has no NaN: a NaN is "NaN".
const FOLDER = join(import.meta.dirname, 'fixtures/sts');

type JsonNumber = number | 'NaN';

type ScoreName =
  | 'cosine_scores'
  | 'manhattan_distances'
  | 'euclidean_distances'
  | 'similarity_scores';

type Predictions = Readonly<Record<ScoreName, number[]>>;

type TaskRun = {
  readonly scores: { readonly test: Record<string, unknown>[] };
  readonly predictions: { readonly default: { readonly test: Predictions } };
  readonly normalized: number[];
};

type Expected = {
  readonly code_point_dim: number;
  readonly min_score: number;
  readonly max_score: number;
  readonly folder: TaskRun;
  readonly stsb: TaskRun & { readonly gold: number[] };
  readonly correlation_cases: readonly {
    readonly case: string;
    readonly x: JsonNumber[];
    readonly y: JsonNumber[];
    readonly rankdata_x: JsonNumber[];
    readonly rankdata_y: JsonNumber[];
    readonly pearson: JsonNumber | { readonly error: string };
    readonly spearman: JsonNumber;
  }[];
};

const expected: Expected = JSON.parse(
  readFileSync(join(FOLDER, 'expected.json'), 'utf8'),
);

function fromJson(value: JsonNumber): number {
  return value === 'NaN' ? Number.NaN : value;
}

const SCORE_NAMES: readonly ScoreName[] = [
  'cosine_scores',
  'manhattan_distances',
  'euclidean_distances',
  'similarity_scores',
];

// TOLERANCE * max(1, |value|) bounds the difference of a score that goes
// through np.einsum or torch: 4 float32 units in the last place at 1, as in
// pair-classification.golden.test.ts. The largest difference seen is 2 units
// at 1, in a cosine of the folder task. The negated Manhattan distance adds
// float32 values in numpy's pairwise order, which the port copies.
const TOLERANCE = 2 ** -21;

// PEARSON_TOLERANCE bounds the difference of pearsonr of the same arrays:
// SciPy adds the products of np.vecdot with BLAS ddot (Accelerate), in an
// order that the port does not copy. 8 float64 units in the last place at 1;
// the largest difference seen is 2 units, for 2000 values. With fewer than 4
// values, ddot adds in order, as the port does, so pearsonr is exact.
const PEARSON_TOLERANCE = 2 ** -49;

// FLOAT32_PEARSON_TOLERANCE bounds the difference of pearsonr of a score
// array that is itself within TOLERANCE of MTEB's. The largest difference
// seen is 1.9e-7, for the similarity of the STSBenchmark slice.
const FLOAT32_PEARSON_TOLERANCE = 2 ** -20;

function assertClose(
  actual: unknown,
  python: unknown,
  tolerance: number,
  name: string,
): void {
  assert.equal(typeof actual, 'number', name);
  assert.equal(typeof python, 'number', name);
  const difference = Math.abs(Number(actual) - Number(python));
  assert.ok(difference <= tolerance, `${name}: ${actual} and ${python}`);
}

// The scores of evaluate: the Spearman correlations and the main score to
// the last bit, the Pearson correlation of the Manhattan distances within
// PEARSON_TOLERANCE and the other Pearson correlations within
// FLOAT32_PEARSON_TOLERANCE.
function assertScores(
  actual: Record<string, unknown> | undefined,
  python: Record<string, unknown> | undefined,
): void {
  assert.deepEqual(Object.keys(actual ?? {}), Object.keys(python ?? {}));
  for (const [name, value] of Object.entries(python ?? {})) {
    const own = actual?.[name];
    if (name === 'manhattan_pearson')
      assertClose(own, value, PEARSON_TOLERANCE, name);
    else if (name.endsWith('pearson'))
      assertClose(own, value, FLOAT32_PEARSON_TOLERANCE, name);
    else assert.deepEqual(own, value, name);
  }
}

// The score arrays: the Manhattan distances to the last bit, the others
// within TOLERANCE of their size.
function assertPredictions(actual: Predictions, python: Predictions): void {
  assert.deepEqual(Object.keys(actual), Object.keys(python));
  for (const name of SCORE_NAMES) {
    if (name === 'manhattan_distances') {
      assert.deepEqual(actual[name], python[name], name);
      continue;
    }
    assert.equal(actual[name].length, python[name].length, name);
    for (const [index, value] of python[name].entries())
      assertClose(
        actual[name][index],
        value,
        TOLERANCE * Math.max(1, Math.abs(value)),
        `${name}[${index}]`,
      );
  }
}

// The metrics of MTEB's own score arrays: the Spearman correlations to the
// last bit and the Pearson correlations within PEARSON_TOLERANCE.
function assertMetricsOfPythonArrays(
  metrics: Readonly<Record<string, number>>,
  python: Record<string, unknown> | undefined,
): void {
  const {
    main_score: _main,
    hf_subset: _subset,
    languages: _languages,
    mteb_version: _version,
    ...scores
  } = python ?? {};
  assert.deepEqual(Object.keys(metrics), Object.keys(scores));
  for (const [name, value] of Object.entries(scores))
    if (name.endsWith('pearson'))
      assertClose(metrics[name], value, PEARSON_TOLERANCE, name);
    else assert.equal(metrics[name], value, name);
}

function scoresOf(predictions: Predictions): STSEvaluatorScores {
  return {
    cosineScores: predictions.cosine_scores,
    manhattanDistances: predictions.manhattan_distances,
    euclideanDistances: predictions.euclidean_distances,
    similarityScores: predictions.similarity_scores,
  };
}

// The folder task of generate.py, with gold scores from -2 to 3. It exposes
// MTEB's _normalize and _calculate_scores, so that the test can give them
// the gold scores and the score arrays of Python.
class FolderTask extends AbsTaskSTS {
  override minScore = expected.min_score;
  override maxScore = expected.max_score;

  constructor() {
    super({
      metadata: new TaskMetadata({
        name: 'STSFixture',
        description: 'The STS fixture of @zukhruf/mteb.',
        dataset: { path: join(FOLDER, 'folder'), revision: '1' },
        type: 'STS',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'cosine_spearman',
      }),
    });
  }

  normalized(score: number): number {
    return this.normalize(score);
  }

  metrics(scores: STSEvaluatorScores, normalizedScores: readonly number[]) {
    return this.calculateScores(scores, normalizedScores);
  }
}

// The vector encoder of generate.py: each text is numbers with spaces
// between them.
function vectorModel(): EmbeddingModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'vector',
    maxEmbeddingsPerCall: undefined,
    supportsParallelCalls: true,
    async doEmbed({ values }) {
      return {
        embeddings: values.map((value) => value.split(' ').map(Number)),
        usage: { tokens: values.length },
        warnings: [],
      };
    },
  };
}

function vectorEncoder(): AiSdkEncoder {
  return new AiSdkEncoder({
    model: vectorModel(),
    modelMeta: ModelMeta.createEmpty({ name: 'test/vector', revision: '1' }),
  });
}

function goldScoresOfFolder(): number[] {
  return readFileSync(join(FOLDER, 'folder/test.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const row: { readonly score: number } = JSON.parse(line);
      return row.score;
    });
}

test('the folder task normalizes negative, zero and positive gold scores from -2 to 3 as MTEB does, to the last bit', () => {
  const task = new FolderTask();

  const normalized = goldScoresOfFolder().map((score) =>
    task.normalized(score),
  );

  assert.deepEqual(normalized, expected.folder.normalized);
});

test('evaluate gives the folder task the Spearman correlations and main score of MTEB to the last bit, and its Pearson correlations within the stated tolerances', async () => {
  const result = await evaluate(vectorEncoder(), new FolderTask(), {
    cache: null,
  });

  assertScores(
    result.taskResults[0]?.scores['test']?.[0],
    expected.folder.scores.test[0],
  );
});

test('the predictions file has the four score arrays of MTEB: the negated Manhattan distances to the last bit, the others within 4 float32 units at 1 of their size', async () => {
  await using folder = await new TemporaryFiles().directory('sts-predictions-');

  await evaluate(vectorEncoder(), new FolderTask(), {
    cache: null,
    predictionFolder: folder.path,
  });

  const file: { default: { test: Predictions } } = JSON.parse(
    readFileSync(join(folder.path, 'STSFixture_predictions.json'), 'utf8'),
  );
  assertPredictions(
    file.default.test,
    expected.folder.predictions.default.test,
  );
});

test("the Spearman correlations of MTEB's own score arrays equal MTEB's to the last bit, and the Pearson correlations are within 8 float64 units at 1", () => {
  const task = new FolderTask();

  const metrics = task.metrics(
    scoresOf(expected.folder.predictions.default.test),
    expected.folder.normalized,
  );

  assertMetricsOfPythonArrays(metrics, expected.folder.scores.test[0]);
});

for (const correlationCase of expected.correlation_cases)
  test(`rankdata and spearmanr of "${correlationCase.case}" equal SciPy's to the last bit, and pearsonr too below 4 values, else within 8 float64 units at 1`, () => {
    const x = correlationCase.x.map(fromJson);
    const y = correlationCase.y.map(fromJson);

    const ranks = { x: rankdata(x), y: rankdata(y) };
    const spearman = spearmanr(x, y);

    assert.deepEqual(ranks, {
      x: correlationCase.rankdata_x.map(fromJson),
      y: correlationCase.rankdata_y.map(fromJson),
    });
    assert.equal(spearman, fromJson(correlationCase.spearman));
    const python = correlationCase.pearson;
    if (typeof python === 'object')
      assert.throws(() => pearsonr(x, y), { message: python.error });
    else if (python === 'NaN' || x.length < 4)
      assert.equal(pearsonr(x, y), fromJson(python));
    else assertClose(pearsonr(x, y), python, PEARSON_TOLERANCE, 'pearson');
  });

// The code point encoder of generate.py: the value at k is the number of
// code points c of the text with c % code_point_dim == k.
function codePointEncoder(): AiSdkEncoder {
  return new AiSdkEncoder({
    model: {
      specificationVersion: 'v4',
      provider: 'test',
      modelId: 'code-points',
      maxEmbeddingsPerCall: undefined,
      supportsParallelCalls: true,
      async doEmbed({ values }) {
        return {
          embeddings: values.map((value) => {
            const vector = new Array<number>(expected.code_point_dim).fill(0);
            for (const character of value) {
              const k =
                (character.codePointAt(0) ?? 0) % expected.code_point_dim;
              vector[k] = (vector[k] ?? 0) + 1;
            }
            return vector;
          }),
          usage: { tokens: values.length },
          warnings: [],
        };
      },
    },
    modelMeta: ModelMeta.createEmpty({
      name: 'test/code-points',
      revision: '1',
    }),
  });
}

// The STSBenchmark slice of generate.py, read from the cache. An endpoint
// that refuses connections fails the test if the task reaches for the
// network. It exposes MTEB's _normalize and _calculate_scores.
class STSBenchmarkSlice extends STSBenchmarkSTS {
  constructor() {
    super({
      hub: { cacheFolder: join(FOLDER, 'hub'), endpoint: 'http://127.0.0.1:9' },
    });
  }

  normalized(score: number): number {
    return this.normalize(score);
  }

  metrics(scores: STSEvaluatorScores, normalizedScores: readonly number[]) {
    return this.calculateScores(scores, normalizedScores);
  }
}

test('STSBenchmark normalizes the gold scores of its slice from 0 to 5 as MTEB does, to the last bit', () => {
  const task = new STSBenchmarkSlice();

  const normalized = expected.stsb.gold.map((score) => task.normalized(score));

  assert.deepEqual(normalized, expected.stsb.normalized);
});

test('evaluate gives STSBenchmark on its slice the Spearman correlations and main score of MTEB to the last bit, and its Pearson correlations within the stated tolerances', async () => {
  const result = await evaluate(codePointEncoder(), new STSBenchmarkSlice(), {
    cache: null,
  });

  assertScores(
    result.taskResults[0]?.scores['test']?.[0],
    expected.stsb.scores.test[0],
  );
});

test('STSBenchmark writes the four score arrays of MTEB: the negated Manhattan distances to the last bit, the others within 4 float32 units at 1 of their size', async () => {
  await using folder = await new TemporaryFiles().directory(
    'stsb-predictions-',
  );

  await evaluate(codePointEncoder(), new STSBenchmarkSlice(), {
    cache: null,
    predictionFolder: folder.path,
  });

  const file: { default: { test: Predictions } } = JSON.parse(
    readFileSync(join(folder.path, 'STSBenchmark_predictions.json'), 'utf8'),
  );
  assertPredictions(file.default.test, expected.stsb.predictions.default.test);
});

test("the Spearman correlations of STSBenchmark's score arrays from MTEB equal MTEB's to the last bit, and the Pearson correlations are within 8 float64 units at 1", () => {
  const task = new STSBenchmarkSlice();

  const metrics = task.metrics(
    scoresOf(expected.stsb.predictions.default.test),
    expected.stsb.normalized,
  );

  assertMetricsOfPythonArrays(metrics, expected.stsb.scores.test[0]);
});
