import assert from 'node:assert/strict';
import { cpSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { EmbeddingModelV4 } from '@ai-sdk/provider';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { createDataloader } from '../../create-dataloaders.ts';
import {
  AiSdkEncoder,
  CachedEmbeddingWrapper,
  ModelMeta,
  NumpyCache,
} from '../../index.ts';
import { SCIDOCS } from '../../tasks/retrieval/eng/scidocs-retrieval.ts';
import type {
  CorpusRow,
  PromptType,
  QueryRow,
} from '../../types/encoder-io.ts';

// fixtures/numpy-cache/ holds what Python MTEB 2.26.28 gave for encode calls
// through CachedEmbeddingWrapper with NumpyCache(initial_vectors=4): the
// cache folders python-cache/ and defect-cache/, and in expected.json the
// texts that the model got and the embeddings of each call.
// fixtures/numpy-cache/generate.py makes them.
type Call = {
  readonly case: string;
  readonly prompt_type: PromptType | null;
  readonly rows: (CorpusRow & QueryRow)[];
  readonly kwargs: { readonly precision?: string };
  readonly model_texts: string[];
  readonly embeddings: number[][];
};

type Expected = {
  readonly task: string;
  readonly initial_vectors: number;
  readonly calls: readonly Call[];
  readonly defect_calls: readonly Call[];
};

const FIXTURE = join(import.meta.dirname, 'fixtures/numpy-cache');

const expected: Expected = JSON.parse(
  readFileSync(join(FIXTURE, 'expected.json'), 'utf8'),
);

const task = new SCIDOCS();

// The encoder of generate.py, as an AI SDK model: each text t gives
// [cp(t) / 7, len(t) / 3, (cp(t) % 13) / 11, 1 / (1 + len(t))]. texts holds
// each text that reached the model.
function recordingEncoder(options: { readonly dimension?: number } = {}) {
  const texts: string[] = [];
  const model: EmbeddingModelV4 = {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'recording',
    maxEmbeddingsPerCall: undefined,
    supportsParallelCalls: true,
    async doEmbed({ values }) {
      texts.push(...values);
      return {
        embeddings: values.map((value) => {
          const characters = [...value];
          const cp = characters.reduce(
            (sum, character) => sum + (character.codePointAt(0) ?? 0),
            0,
          );
          const length = characters.length;
          return [cp / 7, length / 3, (cp % 13) / 11, 1 / (1 + length)].slice(
            0,
            options.dimension ?? 4,
          );
        }),
        usage: { tokens: values.length },
        warnings: [],
      };
    },
  };
  const encoder = new AiSdkEncoder({
    model,
    modelMeta: ModelMeta.createEmpty({ name: 'test/recording', revision: '1' }),
  });
  return { encoder, texts };
}

function wrapperOf(
  encoder: AiSdkEncoder,
  cachePath: string,
): CachedEmbeddingWrapper {
  return new CachedEmbeddingWrapper(
    encoder,
    cachePath,
    (directory) => new NumpyCache(directory, expected.initial_vectors),
  );
}

async function encode(
  wrapper: CachedEmbeddingWrapper,
  call: Pick<Call, 'prompt_type' | 'rows' | 'kwargs'>,
): Promise<number[][]> {
  const embeddings = await wrapper.encode(
    createDataloader(call.rows, {
      taskMetadata: task.metadata,
      promptType: call.prompt_type,
    }),
    {
      taskMetadata: task.metadata,
      hfSplit: 'test',
      hfSubset: 'default',
      promptType: call.prompt_type,
      ...call.kwargs,
    },
  );
  return embeddings.map((row) => [...row]);
}

// Each file below the folder, by its path, as bytes.
function filesOf(folder: string): Map<string, Buffer> {
  return new Map(
    readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path.slice(folder.length + 1), readFileSync(path)] as const;
      })
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

// deepEqual compares numbers with Object.is, so -0 and 0 differ.
test('the calls on an empty folder give the embeddings of MTEB and write the files of MTEB, byte for byte', async () => {
  await using directory = await new TemporaryFiles().directory('mteb-cache-');
  const { encoder, texts } = recordingEncoder();
  using wrapper = wrapperOf(encoder, directory.path);

  for (const call of expected.calls) {
    const start = texts.length;
    const embeddings = await encode(wrapper, call);

    assert.deepEqual(
      { texts: texts.slice(start), embeddings },
      { texts: call.model_texts, embeddings: call.embeddings },
      call.case,
    );
  }
  assert.deepEqual(
    filesOf(directory.path),
    filesOf(join(FIXTURE, 'python-cache')),
  );
});

test('a folder that MTEB wrote gives its embeddings, and the model embeds nothing', async () => {
  await using directory = await new TemporaryFiles().directory('mteb-cache-');
  cpSync(join(FIXTURE, 'python-cache'), directory.path, { recursive: true });
  const { encoder, texts } = recordingEncoder();
  using wrapper = wrapperOf(encoder, directory.path);

  const embeddings = [];
  for (const call of expected.calls)
    embeddings.push(await encode(wrapper, call));

  assert.deepEqual(
    { texts, embeddings },
    { texts: [], embeddings: expected.calls.map((call) => call.embeddings) },
  );
});

test('titled documents and instructed queries reach the model as without the cache, under the keys of MTEB', async () => {
  await using directory = await new TemporaryFiles().directory('mteb-cache-');
  const uncached = recordingEncoder();
  const cached = recordingEncoder();
  using wrapper = wrapperOf(cached.encoder, directory.path);

  const runs = [];
  for (const call of expected.defect_calls) {
    const withoutCache = await uncached.encoder.encode(
      createDataloader(call.rows, {
        taskMetadata: task.metadata,
        promptType: call.prompt_type,
      }),
      {
        taskMetadata: task.metadata,
        hfSplit: 'test',
        hfSubset: 'default',
        promptType: call.prompt_type,
      },
    );
    runs.push({
      withoutCache: withoutCache.map((row) => [...row]),
      first: await encode(wrapper, call),
      second: await encode(wrapper, call),
    });
  }

  assert.deepEqual(cached.texts, uncached.texts);
  assert.deepEqual(cached.texts, [
    'T one',
    'Short two',
    'alpha find',
    'beta rank',
  ]);
  for (const run of runs) {
    assert.deepEqual(run.first, run.withoutCache);
    assert.deepEqual(run.second, run.withoutCache);
  }
  for (const promptType of ['document', 'query'])
    assert.equal(
      readFileSync(
        join(directory.path, expected.task, promptType, 'index.json'),
        'utf8',
      ),
      readFileSync(
        join(FIXTURE, 'defect-cache', expected.task, promptType, 'index.json'),
        'utf8',
      ),
    );
});

test('a failed call of the model leaves the folder without its texts, and the next call embeds them', async () => {
  await using directory = await new TemporaryFiles().directory('mteb-cache-');
  const { encoder, texts } = recordingEncoder();
  const [first, second] = expected.calls;
  assert.ok(first && second);
  {
    using wrapper = wrapperOf(encoder, directory.path);
    await encode(wrapper, first);
  }
  const before = filesOf(directory.path);
  const failing = new AiSdkEncoder({
    model: {
      specificationVersion: 'v4',
      provider: 'test',
      modelId: 'failing',
      maxEmbeddingsPerCall: undefined,
      supportsParallelCalls: true,
      async doEmbed() {
        throw new Error('the server is down');
      },
    },
    modelMeta: ModelMeta.createEmpty({ name: 'test/recording', revision: '1' }),
    maxRetries: 0,
  });

  {
    using wrapper = wrapperOf(failing, directory.path);
    await assert.rejects(encode(wrapper, second), /the server is down/);
  }
  const after = filesOf(directory.path);
  const start = texts.length;
  using wrapper = wrapperOf(encoder, directory.path);
  const embeddings = await encode(wrapper, second);

  assert.deepEqual(after, before);
  assert.deepEqual(
    { texts: texts.slice(start), embeddings },
    { texts: second.model_texts, embeddings: second.embeddings },
  );
});

test('a model of another dimension on a folder throws the error of numpy and stores nothing', async () => {
  await using directory = await new TemporaryFiles().directory('mteb-cache-');
  cpSync(join(FIXTURE, 'python-cache'), directory.path, { recursive: true });
  const before = filesOf(directory.path);
  const { encoder } = recordingEncoder({ dimension: 3 });
  using wrapper = wrapperOf(encoder, directory.path);

  await assert.rejects(
    encode(wrapper, {
      prompt_type: null,
      rows: [{ id: 'x', text: 'omega' }],
      kwargs: {},
    }),
    {
      name: 'RangeError',
      message:
        'could not broadcast input array from shape (3,) into shape (4,)',
    },
  );
  assert.deepEqual(filesOf(directory.path), before);
});

// On an empty folder, as in MTEB, the texts reach the model first: the
// cache hashes a text only when it holds vectors or stores one.
test('a text with a lone surrogate throws the error of Python, and on a folder with vectors it reaches no model', async () => {
  await using directory = await new TemporaryFiles().directory('mteb-cache-');
  cpSync(join(FIXTURE, 'python-cache'), directory.path, { recursive: true });
  const { encoder, texts } = recordingEncoder();
  using wrapper = wrapperOf(encoder, directory.path);

  await assert.rejects(
    encode(wrapper, {
      prompt_type: null,
      rows: [
        { id: 'x', text: 'ok' },
        { id: 'y', text: 'a\u{1F600}\uD800b' },
      ],
      kwargs: {},
    }),
    {
      message:
        "'utf-8' codec can't encode character '\\ud800' in position 2: surrogates not allowed",
    },
  );
  assert.deepEqual(texts, []);
});
