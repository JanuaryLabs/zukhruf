import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { EmbeddingModelV4 } from '@ai-sdk/provider';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import type { Dataset } from '../dependencies/datasets.ts';
import { KNeighborsClassifier } from '../dependencies/sklearn-neighbors.ts';
import { evaluate } from '../evaluate.ts';
import { labelSetsOf } from '../evaluators/sklearn-evaluator.ts';
import { AiSdkEncoder } from '../models/ai-sdk-encoder.ts';
import { ModelMeta } from '../models/model-meta.ts';
import { pythonJsonLoads } from '../results/json.ts';
import { KorHateSpeechMLClassification } from '../tasks/multilabel-classification/kor/kor-hate-speech-ml-classification.ts';
import { AbsTaskMultilabelClassification } from './multilabel-classification.ts';
import { TaskMetadata } from './task-metadata.ts';

// fixtures/multilabel-classification/expected.json holds what Python MTEB
// 2.26.28 (scikit-learn 1.9.1, numpy 2.5.4) gave for two folder tasks
// (fixtures/multilabel-classification/folder, and subsampled, whose task
// keeps 40 of its 90 test rows) with an encoder that reads each text as a
// vector, and for KorHateSpeechMLClassification on a slice of its data
// (fixtures/multilabel-classification/hub, in the cache layout of
// dependencies/datasets.ts) with an encoder that counts code points: the
// undersampling of each experiment, the inputs of each call of the encoder,
// the scores of mteb.evaluate, the predictions file that it wrote, and the
// scores of a second mteb.evaluate of the same task. It also holds the
// error of a task with one label (fixtures/multilabel-classification/
// single). generate.py makes it.
const FOLDER = join(import.meta.dirname, 'fixtures/multilabel-classification');

type EncoderCall = { readonly hf_split: string; readonly texts: string[] };

type Run = {
  readonly undersampling: readonly {
    readonly sample_indices: number[];
    readonly idxs: number[];
  }[];
  readonly encoder_calls: readonly EncoderCall[];
  readonly scores: { readonly test: Record<string, unknown>[] };
  readonly predictions: unknown;
  readonly second_scores: { readonly test: Record<string, unknown>[] };
};

type Expected = {
  readonly code_point_dim: number;
  readonly folder: Run;
  readonly subsampled: Run;
  readonly kor: Run;
  readonly single_error: string;
};

const expected: Expected = JSON.parse(
  readFileSync(join(FOLDER, 'expected.json'), 'utf8'),
);

// The folder tasks of generate.py. experiments() calls the undersampling
// of each experiment as generate.py does, before evaluate, on the task's own
// generator.
class FolderTask extends AbsTaskMultilabelClassification {
  constructor(name: string, folder: string, maxEvalSamples = 3000) {
    super({
      metadata: new TaskMetadata({
        name,
        description: 'The multilabel classification fixture of @zukhruf/mteb.',
        dataset: { path: join(FOLDER, folder), revision: '1' },
        type: 'MultilabelClassification',
        category: 't2c',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'accuracy',
      }),
    });
    this.maxEvalSamples = maxEvalSamples;
  }

  experiments(train: Dataset) {
    const labels = labelSetsOf(train, this.labelColumnName);
    return Array.from({ length: this.nExperiments }, () => {
      const { sampleIndices, idxs } = this.undersampleDataIndices(
        labels,
        this.samplesPerLabel,
      );
      return { sample_indices: sampleIndices, idxs };
    });
  }
}

// The Hub slice of generate.py, read from the cache. An endpoint that
// refuses connections fails the test if the task reaches for the network.
class KorSlice extends KorHateSpeechMLClassification {
  constructor() {
    super({
      hub: {
        cacheFolder: join(FOLDER, 'hub'),
        endpoint: 'http://127.0.0.1:9',
      },
    });
  }

  experiments(train: Dataset) {
    const labels = labelSetsOf(train, this.labelColumnName);
    return Array.from({ length: this.nExperiments }, () => {
      const { sampleIndices, idxs } = this.undersampleDataIndices(
        labels,
        this.samplesPerLabel,
      );
      return { sample_indices: sampleIndices, idxs };
    });
  }
}

const TASKS = [
  ['folder', () => new FolderTask('MultilabelFixture', 'folder')],
  [
    'subsampled',
    () => new FolderTask('SubsampledMultilabelFixture', 'subsampled', 40),
  ],
  ['kor', () => new KorSlice()],
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

// The vector encoder of generate.py.
function vectorEncoder() {
  return recordingEncoder('vector', (text) => text.split(' ').map(Number));
}

// The code point encoder of generate.py.
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

function encoderOf(name: (typeof TASKS)[number][0]) {
  return name === 'kor' ? codePointEncoder() : vectorEncoder();
}

for (const [name, makeTask] of TASKS)
  test(`the undersampling of each experiment of ${name} equals MTEB's: the task's generator shuffles all the indices again for each one`, async () => {
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
      'multilabel-predictions-',
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
    const scores = result.taskResults[0]?.scores['test'];
    assert.deepEqual(
      {
        calls,
        scores,
        // deepEqual ignores the order of keys; MTEB writes
        // scores_per_experiment first.
        keys: Object.keys(scores?.[0] ?? {}),
        predictions: file,
      },
      {
        calls: expected[name].encoder_calls,
        scores: expected[name].scores.test,
        keys: Object.keys(expected[name].scores.test[0] ?? {}),
        predictions: expected[name].predictions,
      },
    );
  });

for (const [name, makeTask] of TASKS)
  test(`a second evaluate of the same ${name} task goes on with the shuffles of the first one and gives MTEB's second scores`, async () => {
    const task = makeTask();
    await evaluate(encoderOf(name).encoder, task, { cache: null });

    const second = await evaluate(encoderOf(name).encoder, task, {
      cache: null,
    });

    assert.deepEqual(
      second.taskResults[0]?.scores['test'],
      expected[name].second_scores.test,
    );
  });

test('a task with one label throws the error of MTEB, as scikit-learn then predicts a 1-D array', async () => {
  const task = new FolderTask('SingleLabelFixture', 'single');

  await assert.rejects(
    evaluate(vectorEncoder().encoder, task, { cache: null }),
    { message: expected.single_error },
  );
});

test("the default evaluator model is MTEB's KNeighborsClassifier with 5 neighbours, and the task keeps 3000 evaluation rows at most", () => {
  const task = new KorHateSpeechMLClassification();

  const model = task.evaluatorModel;

  assert.ok(model instanceof KNeighborsClassifier);
  assert.deepEqual(
    { nNeighbors: model.nNeighbors, maxEvalSamples: task.maxEvalSamples },
    { nNeighbors: 5, maxEvalSamples: 3000 },
  );
});
