import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { EmbeddingModelV4 } from '@ai-sdk/provider';

import { TemporaryFiles } from '@zukhruf/fs';

import {
  AbsTaskRetrieval,
  type RetrievalSplitData,
} from './abstasks/retrieval.ts';
import { TaskMetadata } from './abstasks/task-metadata.ts';
import { ResultCache } from './cache/result-cache.ts';
import { evaluate } from './evaluate.ts';
import { LockWarning } from './index.ts';
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

  protected override async loadSplits(): Promise<
    Map<string, Map<string, RetrievalSplitData>>
  > {
    return new Map([
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

  const result = await evaluate(encoderOf(model), new LetterTask(), {
    cache,
    clock: globalThis,
  });

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
  await evaluate(encoderOf(letterModel().model), new LetterTask(), {
    cache,
    clock: globalThis,
  });
  const second = letterModel();

  const result = await evaluate(encoderOf(second.model), new LetterTask(), {
    cache,
    clock: globalThis,
  });

  assert.equal(second.calls(), 0);
  assert.equal(result.taskResults[0]?.mainScore, 1);
});

test('overwriteStrategy always runs the model again', async () => {
  await using directory = await new TemporaryFiles().directory(
    'mteb-evaluate-',
  );
  const cache = new ResultCache(directory.path);
  await evaluate(encoderOf(letterModel().model), new LetterTask(), {
    cache,
    clock: globalThis,
  });
  const second = letterModel();

  await evaluate(encoderOf(second.model), new LetterTask(), {
    cache,
    overwriteStrategy: 'always',
    clock: globalThis,
  });

  assert.ok(second.calls() > 0);
});

test('without raiseError, a failing task becomes an exception of the result', async () => {
  const { model } = letterModel({ failing: true });

  const result = await evaluate(encoderOf(model), new LetterTask(), {
    cache: null,
    raiseError: false,
    clock: globalThis,
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
    if (Error.isError(error) && 'code' in error && error.code === 'EEXIST')
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
    evaluate(encoderOf(model), new LetterTask(), {
      cache,
      co2Tracker: true,
      clock: globalThis,
    }),
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, NO_FINAL_EMISSIONS);
      assert.ok(Error.isError(error.cause));
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
    { cache: null, co2Tracker: true, raiseError: false, clock: globalThis },
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
    { cache: null, clock: globalThis },
  );

  assert.equal(result.taskResults[0]?.mainScore, 1);
  assert.equal(result.taskResults[0]?.kgCo2Emissions, null);
});

// A program that tracks a task with co2Tracker in the temporary folder of
// argv[1], and exits once the tracker holds codecarbon's lock. Another
// program has then put a folder in place of the lock file, so the release at
// exit fails. Its 'warning' listener writes each LockWarning as JSON to
// stdout, in the exit, where nothing asynchronous runs any more.
const exitingTracker = `
import { existsSync, mkdirSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsTaskRetrieval, AiSdkEncoder, LockWarning, ModelMeta, TaskMetadata, evaluate } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};

process.on('warning', (warning) => {
  if (warning.name !== 'LockWarning') return;
  const { name, code, detail, message, cause } = warning;
  writeSync(1, JSON.stringify({ instance: warning instanceof LockWarning, name, code, detail, message, cause: { code: cause?.code, message: cause?.message } }) + '\\n');
});

class NeverLoads extends AbsTaskRetrieval {
  constructor() {
    super({ metadata: new TaskMetadata({ name: 'Never', description: 'Its splits never load.', dataset: { path: 'local/never', revision: '1' }, type: 'Retrieval', category: 't2t', modalities: ['text'], evalSplits: ['test'], evalLangs: ['eng-Latn'], mainScore: 'ndcg_at_10' }) });
  }
  loadSplits() {
    return new Promise(() => {});
  }
}

const model = { specificationVersion: 'v4', provider: 'test', modelId: 'never', maxEmbeddingsPerCall: undefined, supportsParallelCalls: true, async doEmbed() { throw new Error('No task loads, so nothing embeds.'); } };
const lockfile = join(tmpdir(), '.codecarbon.lock');
void evaluate(new AiSdkEncoder({ model, modelMeta: ModelMeta.createEmpty({ name: 'test/never', revision: '1' }) }), new NeverLoads(), { cache: null, co2Tracker: true, clock: globalThis });
const held = setInterval(() => {
  if (!existsSync(lockfile)) return;
  clearInterval(held);
  rmSync(lockfile);
  mkdirSync(lockfile);
  process.exit(0);
}, 1);
`;

test('with co2Tracker, a release of the lock at exit that fails is a LockWarning with its code and the lock file, and the failure as its cause', async () => {
  // Arrange: the program's own temporary folder holds its codecarbon lock,
  // so no other run on the machine meets it.
  await using folder = await new TemporaryFiles().directory('mteb-co2-');
  const temporary = {
    TMPDIR: folder.path,
    TMP: folder.path,
    TEMP: folder.path,
  };

  // Act
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', exitingTracker],
    {
      env: { ...process.env, ...temporary },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  const [code] = await once(child, 'close');

  // Assert
  assert.equal(code, 0);
  const warnings: unknown[] = stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
  assert.equal(warnings.length, 1);
  const [warning] = warnings;
  assert.ok(
    typeof warning === 'object' && warning !== null && 'cause' in warning,
  );
  const { cause, ...rest } = warning;
  assert.ok(
    typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      'message' in cause,
  );
  assert.deepEqual(rest, {
    instance: true,
    name: 'LockWarning',
    code: 'ZUKHRUF_MTEB_LOCK_RELEASE_FAILED',
    detail: `lockfile: ${join(folder.path, '.codecarbon.lock')}`,
    message: `The release of the lock at exit failed, and the next lock is released: ${String(cause.message)}`,
  });
  assert.ok(
    ['EPERM', 'EISDIR'].includes(String(cause.code)),
    `the unlink of the folder must be the cause, not ${JSON.stringify(cause)}`,
  );
});
