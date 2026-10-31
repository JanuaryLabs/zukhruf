import assert from 'node:assert/strict';
import { closeSync, openSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { EmbeddingModelV4 } from '@ai-sdk/provider';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { AbsTaskRetrieval } from './abstasks/retrieval.ts';
import { TaskMetadata } from './abstasks/task-metadata.ts';
import { ResultCache } from './cache/result-cache.ts';
import { evaluate } from './evaluate.ts';
import { AiSdkEncoder } from './models/ai-sdk-encoder.ts';
import { ModelMeta } from './models/model-meta.ts';

// A real embedding model cannot run in CI. This one implements the AI SDK
// interface: each text gets a one-hot vector of its first letter, and the
// model counts its calls. failing makes every call throw.
function letterModel(options: { readonly failing?: boolean } = {}): {
  readonly model: EmbeddingModelV4;
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    model: {
      specificationVersion: 'v4',
      provider: 'test',
      modelId: 'letters',
      maxEmbeddingsPerCall: undefined,
      supportsParallelCalls: true,
      async doEmbed({ values }) {
        calls++;
        if (options.failing) throw new Error('The model is down.');
        return {
          embeddings: values.map((value) =>
            ['a', 'b', 'c'].map((letter) => (value.startsWith(letter) ? 1 : 0)),
          ),
          usage: { tokens: values.length },
          warnings: [],
        };
      },
    },
  };
}

class LetterTask extends AbsTaskRetrieval {
  constructor() {
    super({
      metadata: new TaskMetadata({
        name: 'Letters',
        description: 'Each query finds the document of its first letter.',
        dataset: { path: 'local/letters', revision: '1' },
        type: 'Retrieval',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'ndcg_at_10',
      }),
    });
  }

  override async loadData(): Promise<void> {
    this.dataset = new Map([
      [
        'default',
        new Map([
          [
            'test',
            {
              corpus: [
                { id: 'd-a', text: 'apple' },
                { id: 'd-b', text: 'banana' },
                { id: 'd-c', text: 'cherry' },
              ],
              queries: [
                { id: 'q-a', text: 'a fruit' },
                { id: 'q-b', text: 'b fruit' },
              ],
              relevantDocs: new Map([
                ['q-a', new Map([['d-a', 1]])],
                ['q-b', new Map([['d-b', 1]])],
              ]),
              topRanked: null,
            },
          ],
        ]),
      ],
    ]);
  }
}

function encoderOf(model: EmbeddingModelV4): AiSdkEncoder {
  return new AiSdkEncoder({
    model,
    modelMeta: ModelMeta.createEmpty({ name: 'test/letters', revision: '1' }),
  });
}

test('evaluate scores the task and saves the result in the cache', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-evaluate-',
  );
  const { model } = letterModel();
  const cache = new ResultCache(directory.path);

  const result = await evaluate(encoderOf(model), new LetterTask(), { cache });

  const [taskResult] = result.taskResults;
  const [scores] = taskResult?.scores.test ?? [];
  assert.equal(scores?.main_score, 1);
  assert.equal(scores?.hf_subset, 'default');
  assert.deepEqual(scores?.languages, ['eng-Latn']);
  assert.equal(
    cache.loadTaskResult('Letters', encoderOf(model).mtebModelMeta)?.mainScore,
    1,
  );
});

test('a second evaluate of the same model loads the cached result and does not call the model', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-evaluate-',
  );
  const cache = new ResultCache(directory.path);
  await evaluate(encoderOf(letterModel().model), new LetterTask(), { cache });
  const second = letterModel();

  const result = await evaluate(encoderOf(second.model), new LetterTask(), {
    cache,
  });

  assert.equal(second.calls(), 0);
  assert.equal(result.taskResults[0]?.mainScore, 1);
});

test('overwriteStrategy always runs the model again', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-evaluate-',
  );
  const cache = new ResultCache(directory.path);
  await evaluate(encoderOf(letterModel().model), new LetterTask(), { cache });
  const second = letterModel();

  await evaluate(encoderOf(second.model), new LetterTask(), {
    cache,
    overwriteStrategy: 'always',
  });

  assert.ok(second.calls() > 0);
});

test('without raiseError, a failing task becomes an exception of the result', async () => {
  const { model } = letterModel({ failing: true });

  const result = await evaluate(encoderOf(model), new LetterTask(), {
    cache: null,
    raiseError: false,
  });

  assert.deepEqual(result.taskResults, []);
  assert.equal(result.exceptions?.[0]?.taskName, 'Letters');
  assert.match(result.exceptions?.[0]?.exception ?? '', /The model is down/u);
});

// codecarbon's lock is one file for the whole machine. Only this file takes
// it, and node:test runs the tests of a file one after another. A lock that
// another run holds stays: the test then runs against that one.
function holdCodecarbonLock(): Disposable {
  const path = join(tmpdir(), '.codecarbon.lock');
  try {
    closeSync(openSync(path, 'wx'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      return { [Symbol.dispose]() {} };
    throw error;
  }
  return {
    [Symbol.dispose]() {
      unlinkSync(path);
    },
  };
}

const NO_FINAL_EMISSIONS =
  "'EmissionsTracker' object has no attribute 'final_emissions'";

test('with co2Tracker, a task that runs while another codecarbon run holds the lock throws the AttributeError of MTEB after the task ran', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-evaluate-',
  );
  using _lock = holdCodecarbonLock();
  const { model, calls } = letterModel();
  const cache = new ResultCache(directory.path);

  await assert.rejects(
    evaluate(encoderOf(model), new LetterTask(), { cache, co2Tracker: true }),
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, NO_FINAL_EMISSIONS);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /Another instance of codecarbon/);
      return true;
    },
  );
  assert.ok(calls() > 0);
  const saved = cache.loadTaskResult('Letters', encoderOf(model).mtebModelMeta);
  assert.equal(saved?.mainScore, 1);
  assert.equal(saved.kgCo2Emissions, null);
});

test('with co2Tracker and raiseError false, the held lock makes the task an error of the result', async () => {
  using _lock = holdCodecarbonLock();

  const result = await evaluate(
    encoderOf(letterModel().model),
    new LetterTask(),
    { cache: null, co2Tracker: true, raiseError: false },
  );

  assert.deepEqual(result.taskResults, []);
  assert.deepEqual(result.exceptions, [
    { taskName: 'Letters', exception: NO_FINAL_EMISSIONS },
  ]);
});

test('without co2Tracker, evaluate does not track: a held lock changes nothing', async () => {
  using _lock = holdCodecarbonLock();

  const result = await evaluate(
    encoderOf(letterModel().model),
    new LetterTask(),
    { cache: null },
  );

  assert.equal(result.taskResults[0]?.mainScore, 1);
  assert.equal(result.taskResults[0]?.kgCo2Emissions, null);
});
