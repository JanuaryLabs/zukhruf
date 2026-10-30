import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { EmbeddingModelV4 } from '@ai-sdk/provider';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import type { Dataset } from '../dependencies/datasets.ts';
import {
  type FittedLogisticRegression,
  LogisticRegression,
} from '../dependencies/sklearn-logistic.ts';
import type { ClassLabel } from '../dependencies/sklearn.ts';
import { evaluate } from '../evaluate.ts';
import { AiSdkEncoder } from '../models/ai-sdk-encoder.ts';
import { ModelMeta } from '../models/model-meta.ts';
import { pythonJsonLoads } from '../results/json.ts';
import {
  Banking77Classification,
  Banking77ClassificationV2,
} from '../tasks/classification/eng/banking77-classification.ts';
import type { Embeddings } from '../types/encoder-io.ts';
import {
  AbsTaskClassification,
  type ClassificationMetrics,
} from './classification.ts';
import { TaskMetadata } from './task-metadata.ts';

// fixtures/classification/expected.json holds what Python MTEB 2.26.28
// (scikit-learn 1.9.1, scipy 1.18.1, numpy 2.5.4) gave for two folder tasks
// (fixtures/classification/folder and binary) with an encoder that reads
// each text as a vector, and for Banking77Classification and its v2 on
// slices of their data (fixtures/classification/hub, in the cache layout of
// dependencies/datasets.ts) with an encoder that counts code points: the
// undersampling of each experiment, the inputs of each call of the
// encoder, the scores of mteb.evaluate and the predictions file that it
// wrote. For the folder tasks it also holds the LogisticRegression of each
// experiment. generate.py makes it.
const FOLDER = join(import.meta.dirname, 'fixtures/classification');

type EncoderCall = { readonly hf_split: string; readonly texts: string[] };

type Run = {
  readonly undersampling: readonly {
    readonly idxs: number[];
    readonly selected: number[];
  }[];
  readonly encoder_calls: readonly EncoderCall[];
  readonly scores: { readonly test: Record<string, unknown>[] };
  readonly predictions: {
    readonly default: { readonly test: ClassLabel[][] };
  };
  readonly fits: readonly {
    readonly n_iter: number;
    readonly coef: number[][];
    readonly intercept: number[];
  }[];
};

type Expected = {
  readonly code_point_dim: number;
  readonly evaluator_model: {
    readonly max_iter: number;
    readonly C: number;
    readonly tol: number;
  };
  readonly folder: Run;
  readonly binary: Run;
  readonly banking77: Run;
  readonly banking77_v2: Run;
};

// generate.py writes a NaN score as the string "NaN".
const expected: Expected = JSON.parse(
  readFileSync(join(FOLDER, 'expected.json'), 'utf8'),
  (_key, value: unknown) => (value === 'NaN' ? Number.NaN : value),
);
// The folder tasks of generate.py. They expose MTEB's undersampling and
// metrics, so that the test can give them the labels of Python.
class FolderTask extends AbsTaskClassification {
  constructor(name: string, folder: string) {
    super({
      metadata: new TaskMetadata({
        name,
        description: 'The classification fixture of @zukhruf/mteb.',
        dataset: { path: join(FOLDER, folder), revision: '1' },
        type: 'Classification',
        category: 't2c',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'accuracy',
      }),
    });
  }

  experiments(train: Dataset) {
    return this.undersampleExperiments(train);
  }

  scores(yTest: readonly ClassLabel[], yPred: readonly ClassLabel[]) {
    return this.calculateScores(yTest, yPred);
  }

  averages(scores: readonly ClassificationMetrics[]) {
    return this.calculateAvgScores(scores);
  }
}

const FOLDER_TASKS = [
  ['folder', 'ClassificationFixture'],
  ['binary', 'BinaryClassificationFixture'],
] as const;

// An encoder whose texts the test reads back.
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
    calls.push({
      hf_split: options.hfSplit,
      texts: inputs.flatMap((batch) => batch.text),
    });
    return encode(inputs, options);
  };
  return { encoder, calls };
}

// The vector encoder of generate.py: each text is numbers with spaces
// between them.
function vectorEncoder() {
  return recordingEncoder('vector', (text) => text.split(' ').map(Number));
}

// The code point encoder of generate.py: the value at k is the float32
// share of the code points c of the text with c % code_point_dim == k.
function codePointEncoder() {
  return recordingEncoder('code-points', (text) => {
    const vector = new Array<number>(expected.code_point_dim).fill(0);
    const characters = [...text];
    for (const character of characters) {
      const k = (character.codePointAt(0) ?? 0) % expected.code_point_dim;
      vector[k] = (vector[k] ?? 0) + 1;
    }
    return vector.map((count) => Math.fround(count / characters.length));
  });
}

// A LogisticRegression that keeps each fitted model.
class RecordingLogisticRegression extends LogisticRegression {
  readonly fits: FittedLogisticRegression[] = [];

  override fit(x: Embeddings, y: readonly ClassLabel[]) {
    const fitted = super.fit(x, y);
    this.fits.push(fitted);
    return fitted;
  }
}

// The Hub slices of generate.py, read from the cache. An endpoint that
// refuses connections fails the test if the task reaches for the network.
const HUB = {
  cacheFolder: join(FOLDER, 'hub'),
  endpoint: 'http://127.0.0.1:9',
};

// The Banking77 tasks on the Hub slices, with their undersampling exposed.
class Banking77Slice extends Banking77Classification {
  constructor() {
    super({ hub: HUB });
  }

  experiments(train: Dataset) {
    return this.undersampleExperiments(train);
  }
}

class Banking77SliceV2 extends Banking77ClassificationV2 {
  constructor() {
    super({ hub: HUB });
  }

  experiments(train: Dataset) {
    return this.undersampleExperiments(train);
  }
}

const TASKS = [
  ['folder', () => new FolderTask('ClassificationFixture', 'folder')],
  ['binary', () => new FolderTask('BinaryClassificationFixture', 'binary')],
  ['banking77', () => new Banking77Slice()],
  ['banking77_v2', () => new Banking77SliceV2()],
] as const;

function encoderOf(name: (typeof TASKS)[number][0]) {
  return name.startsWith('banking77') ? codePointEncoder() : vectorEncoder();
}

for (const [name, makeTask] of TASKS)
  test(`the undersampling of each experiment of ${name} equals MTEB's: each one shuffles the shuffled indices again from the same seed`, async () => {
    const task = makeTask();
    await task.loadData();
    const train = task.dataset?.get('default')?.get('train');
    assert.ok(train);

    const experiments = task.experiments(train);

    assert.deepEqual(experiments, expected[name].undersampling);
  });

for (const [name, makeTask] of TASKS)
  test(`evaluate gives ${name} the encoder inputs, the scores and the predictions file of MTEB, to the last bit`, async () => {
    await using folder = await new TemporaryFiles().directory(
      'classification-predictions-',
    );
    const task = makeTask();
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
    assert.deepEqual(
      {
        calls,
        scores: result.taskResults[0]?.scores['test'],
        predictions: file,
      },
      {
        calls: expected[name].encoder_calls,
        scores: expected[name].scores.test,
        predictions: expected[name].predictions,
      },
    );
  });

// A fit adds float32 values and float64 dot products in another order than
// Accelerate's BLAS (sklearn-logistic.ts): its coefficients are within
// TOLERANCE * max(1, |value|) of scikit-learn's. The largest difference seen
// is 3.6e-7, in the folder task.
const TOLERANCE = 1e-5;

for (const [name, makeTask] of TASKS)
  test(`the LogisticRegression of each experiment of ${name} has scikit-learn's n_iter_, and coefficients within 1e-5`, async () => {
    const task = makeTask();
    const model = new RecordingLogisticRegression({ maxIter: 100 });
    task.evaluatorModel = model;

    await evaluate(encoderOf(name).encoder, task, { cache: null });

    const fits = expected[name].fits;
    assert.deepEqual(
      model.fits.map((fit) => fit.nIter),
      fits.map((fit) => fit.n_iter),
    );
    for (const [i, fit] of fits.entries()) {
      const actual = model.fits[i];
      const values = [
        ...(actual?.coef ?? []).flatMap((row) => [...row]),
        ...(actual?.intercept ?? []),
      ];
      const python = [...fit.coef.flat(), ...fit.intercept];
      assert.equal(values.length, python.length);
      for (const [j, value] of python.entries())
        assert.ok(
          Math.abs((values[j] ?? Number.NaN) - value) <=
            TOLERANCE * Math.max(1, Math.abs(value)),
          `experiment ${i}, value ${j}: ${values[j]} and ${value}`,
        );
    }
  });

for (const [name, taskName] of FOLDER_TASKS)
  test(`the metrics of MTEB's own predictions of ${name} equal MTEB's scores of each experiment and their means, in MTEB's order, to the last bit`, () => {
    const task = new FolderTask(taskName, name);
    const yTest = readFileSync(join(FOLDER, name, 'test.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const row: { readonly label: number } = JSON.parse(line);
        return row.label;
      });

    const scores = expected[name].predictions.default.test.map((yPred) =>
      task.scores(yTest, yPred),
    );

    const {
      main_score: _main,
      hf_subset: _subset,
      languages: _languages,
      mteb_version: _version,
      ...python
    } = expected[name].scores.test[0] ?? {};
    assert.deepEqual(
      Object.entries(task.averages(scores)),
      Object.entries(python),
    );
  });

test("the default evaluator model is MTEB's LogisticRegression: max_iter 100, C 1 and tol 1e-4", () => {
  const task = new FolderTask('ClassificationFixture', 'folder');

  const model = task.evaluatorModel;

  assert.ok(model instanceof LogisticRegression);
  assert.deepEqual(
    { max_iter: model.maxIter, C: model.C, tol: model.tol },
    expected.evaluator_model,
  );
});
