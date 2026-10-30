import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { EmbeddingModelV4 } from '@ai-sdk/provider';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { evaluate } from '../evaluate.ts';
import type { PairClassificationDistances } from '../evaluators/pair-classification-evaluator.ts';
import { AiSdkEncoder } from '../models/ai-sdk-encoder.ts';
import { ModelMeta } from '../models/model-meta.ts';
import { SprintDuplicateQuestionsPC } from '../tasks/pair-classification/eng/sprint-duplicate-questions-pc.ts';
import { AbsTaskPairClassification } from './pair-classification.ts';
import { TaskMetadata } from './task-metadata.ts';

// fixtures/pair-classification/expected.json holds what Python MTEB 2.26.28
// (scikit-learn 1.9.1, numpy 2.5.4, torch 2.14.1) gave for the folder task
// of fixtures/pair-classification/folder with an encoder that reads each
// text as a vector: the scores of mteb.evaluate, the predictions file that
// it wrote, and the best accuracy and F1 with their thresholds for each
// array of that file. It holds the same for SprintDuplicateQuestions on a
// slice of its data (fixtures/pair-classification/hub, in the cache layout
// of dependencies/datasets.ts) with an encoder that counts code points. It
// also holds the metrics of _compute_metrics_values
// for score arrays made in generate.py. generate.py makes it.
const FOLDER = join(import.meta.dirname, 'fixtures/pair-classification');

type ScoreName =
  | 'cosine_scores'
  | 'euclidean_distances'
  | 'manhattan_distances'
  | 'similarity_scores'
  | 'dot_scores';

type Predictions = Readonly<Record<ScoreName, number[]>>;

type Thresholds = {
  readonly accuracy: [number, number];
  readonly f1: [number, number, number, number];
};

type Expected = {
  readonly code_point_dim: number;
  readonly sprint: {
    readonly scores: { readonly test: Record<string, unknown>[] };
    readonly predictions: {
      readonly default: { readonly test: Predictions };
    };
  };
  readonly folder: {
    readonly scores: { readonly test: Record<string, unknown>[] };
    readonly predictions: {
      readonly default: { readonly test: Predictions };
    };
    readonly thresholds: Readonly<Record<ScoreName, Thresholds>>;
  };
  readonly metric_cases: readonly {
    readonly case: string;
    readonly scores: number[];
    readonly labels: number[];
    readonly high: Thresholds & { readonly metrics: Record<string, number> };
    readonly low: Thresholds & { readonly metrics: Record<string, number> };
  }[];
};

const expected: Expected = JSON.parse(
  readFileSync(join(FOLDER, 'expected.json'), 'utf8'),
);

const SCORE_NAMES: readonly ScoreName[] = [
  'cosine_scores',
  'euclidean_distances',
  'manhattan_distances',
  'similarity_scores',
  'dot_scores',
];

// The arrays that only add float32 values in numpy's pairwise order, which
// the port copies. The others go through np.einsum, BLAS sdot or torch,
// whose order of addition the port does not copy.
const EXACT: ReadonlySet<ScoreName> = new Set(['manhattan_distances']);

// TOLERANCE * max(1, m) bounds the difference of a value that goes through
// np.einsum, BLAS sdot or torch: 4 float32 units in the last place at 1. The
// port adds those sums in float64 and rounds once; Python adds them in
// float32 in another order, so the error grows with the size of the terms.
// m is |value| for the cosine, the similarity and the Euclidean distance,
// whose rows are normalized or whose terms are squares. m is the sum of
// |a_i * b_i| for the dot product, whose terms cancel. The largest
// difference seen is 1 unit at 1, in a cosine and a similarity.
const TOLERANCE = 2 ** -21;

// The scores of each pair equal MTEB's to the last bit where the port adds
// in numpy's order, and within TOLERANCE elsewhere. dotMagnitudes holds the
// sum of |a_i * b_i| of each pair.
function assertPredictions(
  actual: Predictions,
  python: Predictions,
  dotMagnitudes: readonly number[],
): void {
  assert.deepEqual(Object.keys(actual), Object.keys(python));
  for (const name of SCORE_NAMES) {
    if (EXACT.has(name)) {
      assert.deepEqual(actual[name], python[name], name);
      continue;
    }
    assert.equal(actual[name].length, python[name].length, name);
    for (const [index, value] of python[name].entries()) {
      const magnitude =
        name === 'dot_scores'
          ? (dotMagnitudes[index] ?? Number.NaN)
          : Math.abs(value);
      const difference = Math.abs((actual[name][index] ?? Number.NaN) - value);
      assert.ok(
        difference <= TOLERANCE * Math.max(1, magnitude),
        `${name}[${index}]: ${actual[name][index]} and ${value}`,
      );
    }
  }
}

// The folder task of generate.py. It exposes MTEB's metric functions, so
// that the test can give them the score arrays of Python.
class FolderTask extends AbsTaskPairClassification {
  constructor() {
    super({
      metadata: new TaskMetadata({
        name: 'PairFixture',
        description: 'The pair classification fixture of @zukhruf/mteb.',
        dataset: { path: join(FOLDER, 'folder'), revision: '1' },
        type: 'PairClassification',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'max_ap',
      }),
    });
  }

  metrics(distances: PairClassificationDistances, labels: readonly number[]) {
    return this.computeMetrics(distances, labels);
  }

  metricsValues(
    scores: readonly number[],
    labels: readonly number[],
    high: boolean,
  ) {
    return {
      metrics: { ...this.computeMetricsValues(scores, labels, high) },
      accuracy: this.findBestAccAndThreshold(scores, labels, high),
      f1: this.findBestF1AndThreshold(scores, labels, high),
    };
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

const python = expected.folder.predictions.default.test;

type FolderRow = {
  readonly sentence1: string;
  readonly sentence2: string;
  readonly labels: number;
};

function folderRows(): FolderRow[] {
  return readFileSync(join(FOLDER, 'folder/test.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const row: FolderRow = JSON.parse(line);
      return row;
    });
}

function labelsOfFolder(): number[] {
  return folderRows().map((row) => row.labels);
}

// The sum of |a_i * b_i| of the float32 vectors of each pair.
function folderDotMagnitudes(): number[] {
  const vector = (text: string) => Float32Array.from(text.split(' '), Number);
  return folderRows().map((row) => {
    const left = vector(row.sentence1);
    const right = vector(row.sentence2);
    let total = 0;
    for (const [index, value] of left.entries())
      total += Math.abs(value * (right[index] ?? 0));
    return total;
  });
}

test('evaluate gives the folder task the scores of MTEB, max_ap as the main score, to the last bit', async () => {
  const result = await evaluate(vectorEncoder(), new FolderTask(), {
    cache: null,
  });

  assert.deepEqual(
    result.taskResults[0]?.scores['test'],
    expected.folder.scores.test,
  );
});

test('the predictions file has the five score arrays of MTEB: Manhattan to the last bit, the others within 4 float32 units at 1 of their size', async () => {
  await using folder = await new TemporaryFiles().directory(
    'pair-predictions-',
  );

  await evaluate(vectorEncoder(), new FolderTask(), {
    cache: null,
    predictionFolder: folder.path,
  });

  const file: { default: { test: Predictions } } = JSON.parse(
    readFileSync(join(folder.path, 'PairFixture_predictions.json'), 'utf8'),
  );
  assertPredictions(file.default.test, python, folderDotMagnitudes());
});

test("the metrics of MTEB's own score arrays equal MTEB's scores to the last bit", () => {
  const task = new FolderTask();

  const metrics = task.metrics(
    {
      cosineScores: python.cosine_scores,
      euclideanDistances: python.euclidean_distances,
      manhattanDistances: python.manhattan_distances,
      similarityScores: python.similarity_scores,
      dotScores: python.dot_scores,
    },
    labelsOfFolder(),
  );

  const {
    main_score: _main,
    hf_subset: _subset,
    languages: _languages,
    mteb_version: _version,
    ...scores
  } = expected.folder.scores.test[0] ?? {};
  assert.deepEqual(Object.entries(metrics), Object.entries(scores));
});

for (const name of SCORE_NAMES)
  test(`the best accuracy and F1 of MTEB's ${name} and their thresholds equal MTEB's to the last bit`, () => {
    const task = new FolderTask();
    const high = !name.endsWith('_distances');

    const { accuracy, f1 } = task.metricsValues(
      python[name],
      labelsOfFolder(),
      high,
    );

    assert.deepEqual({ accuracy, f1 }, expected.folder.thresholds[name]);
  });

for (const metricCase of expected.metric_cases)
  test(`the metrics and thresholds of "${metricCase.case}" equal MTEB's to the last bit`, () => {
    const task = new FolderTask();

    const actual = {
      high: task.metricsValues(metricCase.scores, metricCase.labels, true),
      low: task.metricsValues(metricCase.scores, metricCase.labels, false),
    };

    assert.deepEqual(actual, { high: metricCase.high, low: metricCase.low });
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

// The Hub slice of generate.py, read from the cache. An endpoint that
// refuses connections fails the test if the task reaches for the network.
function sprintSlice(): SprintDuplicateQuestionsPC {
  return new SprintDuplicateQuestionsPC({
    hub: { cacheFolder: join(FOLDER, 'hub'), endpoint: 'http://127.0.0.1:9' },
  });
}

test('evaluate gives SprintDuplicateQuestions on its v1 slice the scores of MTEB, max_ap as the main score, to the last bit', async () => {
  const result = await evaluate(codePointEncoder(), sprintSlice(), {
    cache: null,
  });

  assert.deepEqual(
    result.taskResults[0]?.scores['test'],
    expected.sprint.scores.test,
  );
});

test('SprintDuplicateQuestions writes the five score arrays of MTEB: Manhattan to the last bit, the others within 4 float32 units at 1 of their size', async () => {
  await using folder = await new TemporaryFiles().directory(
    'sprint-predictions-',
  );

  await evaluate(codePointEncoder(), sprintSlice(), {
    cache: null,
    predictionFolder: folder.path,
  });

  const file: { default: { test: Predictions } } = JSON.parse(
    readFileSync(
      join(folder.path, 'SprintDuplicateQuestions_predictions.json'),
      'utf8',
    ),
  );
  // The code point counts are not negative, so the sum of |a_i * b_i| is the
  // dot product.
  const sprint = expected.sprint.predictions.default.test;
  assertPredictions(file.default.test, sprint, sprint.dot_scores);
});
