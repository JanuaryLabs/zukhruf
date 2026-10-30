import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { EmbeddingModelV4 } from '@ai-sdk/provider';

import { ValidationError } from '../abstasks/task-metadata.ts';
import { qwen3Embedding0B6 } from './model-implementations/qwen3-models.ts';
import {
  type LoadKwargs,
  type LoaderOptions,
  ModelMeta,
  type ModelMetaInput,
  ScoringFunction,
  mergePrecisionIntoExperimentKwargs,
  serializeExperimentKwargsToName,
} from './model-meta.ts';
import type { SearchProtocol } from './models-protocols.ts';

// The fields of ModelMeta that have no default, all empty.
const REQUIRED: Omit<ModelMetaInput, 'name'> = {
  loader: null,
  revision: null,
  releaseDate: null,
  languages: null,
  nParameters: null,
  memoryUsageMb: null,
  maxTokens: null,
  embedDim: null,
  license: null,
  openWeights: null,
  publicTrainingCode: null,
  publicTrainingData: null,
  framework: [],
  similarityFnName: null,
  useInstructions: null,
  trainingDatasets: null,
};

// Ported from tests/test_models/test_model_meta.py of MTEB 2.26.28, the tests
// that need no model registry and no HuggingFace Hub. The expected values of
// the other tests come from MTEB 2.26.28 in Python.
describe('ModelMeta', () => {
  test('metadata with the same name, revision, dimension and experiment has the same hash key', () => {
    const model1 = ModelMeta.createEmpty({
      name: 'test/test_model',
      revision: 'test_rev',
      embedDim: 384,
      experimentKwargs: { param1: 'value1' },
    });
    const model2 = ModelMeta.createEmpty({
      name: 'test/test_model2',
      revision: 'test_rev2',
      embedDim: 512,
      experimentKwargs: { param1: 'value2' },
    });
    const model3 = ModelMeta.createEmpty({
      name: 'test/test_model',
      revision: 'test_rev',
      embedDim: 384,
      experimentKwargs: { param1: 'value1' },
    });

    const keys = (models: ModelMeta[]) =>
      new Set(models.map((model) => model.hashKey())).size;

    assert.equal(model1.hashKey(), model3.hashKey());
    assert.equal(keys([model1, model2]), 2);
    assert.equal(keys([model1, model3]), 1);
    assert.equal(model1.equals(model3), true);
    assert.equal(model1.equals(model2), false);
  });

  for (const license of ['apache-2.0', 'openmdw-1.1'])
    test(`a model with the ${license} license and every artifact open scores 6 on openness`, () => {
      const meta = ModelMeta.createEmpty({
        name: 'test/openness',
        revision: 'test',
        openWeights: true,
        license,
        publicTrainingCode: 'https://github.com/example/train',
        publicTrainingData: 'https://huggingface.co/datasets/example',
        citation: '@article{example}',
      });

      assert.equal(meta.openLicense, true);
      assert.equal(meta.opennessScore, 6);
      assert.ok(Object.values(meta.openness).every(Boolean));
    });

  test('a closed model scores 1 on openness, for its model card', () => {
    const meta = ModelMeta.createEmpty({
      name: 'test/openness',
      revision: 'test',
      openWeights: false,
    });

    assert.equal(meta.openLicense, false);
    assert.equal(meta.opennessScore, 1);
    assert.equal(meta.openness['model card'], true);
    assert.ok(
      Object.entries(meta.openness)
        .filter(([dimension]) => dimension !== 'model card')
        .every(([, open]) => !open),
    );
  });

  test('a non-commercial license does not count as open', () => {
    const meta = ModelMeta.createEmpty({
      name: 'test/openness',
      revision: 'test',
      openWeights: true,
      license: 'cc-by-nc-4.0',
    });

    assert.equal(meta.openLicense, false);
    assert.equal(meta.openness['open weights'], true);
    assert.equal(meta.openness['open license'], false);
    assert.equal(meta.opennessScore, 2);
  });

  test('a name without an organization throws', () => {
    assert.throws(
      () =>
        new ModelMeta({ ...REQUIRED, name: 'test_model', revision: 'test' }),
      (error: unknown) =>
        error instanceof ValidationError &&
        error.message.includes('Model name must be in the format'),
    );
  });

  test('a similarity function name of sentence-transformers or PyLate is valid, and an unknown one throws', () => {
    const dot = new ModelMeta({
      ...REQUIRED,
      name: 'a/b',
      similarityFnName: 'dot',
    });

    assert.equal(dot.similarityFnName, ScoringFunction.DOT_PRODUCT);
    assert.throws(
      () =>
        new ModelMeta({
          ...REQUIRED,
          name: 'a/b',
          // @ts-expect-error -- not a scoring function, on purpose.
          similarityFnName: 'jaccard',
        }),
      /similarityFnName\n {2}Value error, Invalid similarity function name: jaccard/u,
    );
  });

  test('fields are validated as pydantic validates them', () => {
    const meta = new ModelMeta({
      ...REQUIRED,
      name: 'a/b',
      license: 'https://x.y',
      trainingDatasets: ['X', 'X'],
      maxTokens: Number.POSITIVE_INFINITY,
      outputDtypes: ['int8'],
    });

    assert.equal(meta.license, 'https://x.y/');
    assert.deepEqual(meta.trainingDatasets, new Set(['X']));
    assert.equal(meta.maxTokens, Number.POSITIVE_INFINITY);
    assert.throws(
      () => new ModelMeta({ ...REQUIRED, name: 'a/b', license: 'weird' }),
      /license/u,
    );
    assert.throws(
      () => new ModelMeta({ ...REQUIRED, name: 'a/b', languages: ['xx-Latn'] }),
      /languages\n {2}Value error, Invalid language code: xx/u,
    );
    assert.throws(
      () => new ModelMeta({ ...REQUIRED, name: 'a/b', nParameters: 1.5 }),
      /nParameters/u,
    );
    assert.throws(
      // @ts-expect-error -- not a framework, on purpose.
      () => new ModelMeta({ ...REQUIRED, name: 'a/b', framework: ['Nope'] }),
      /framework\.0/u,
    );
  });

  test('the deprecated isCrossEncoder sets the model type', () => {
    const meta = new ModelMeta({
      ...REQUIRED,
      name: 'a/b',
      isCrossEncoder: true,
    });

    assert.deepEqual(meta.modelType, ['cross-encoder']);
    assert.equal(meta.isCrossEncoder, true);
  });

  test('toDict of an empty metadata gives the model_meta.json of MTEB, key for key and in its order', () => {
    const expected = {
      loader_kwargs: {},
      name: 'no_model_name/available',
      revision: 'no_revision_available',
      release_date: null,
      languages: null,
      n_parameters: null,
      n_active_parameters_override: null,
      n_embedding_parameters: null,
      memory_usage_mb: null,
      max_tokens: null,
      embed_dim: null,
      license: null,
      open_weights: null,
      public_training_code: null,
      public_training_data: null,
      framework: [],
      reference: null,
      similarity_fn_name: null,
      use_instructions: null,
      training_datasets: null,
      adapted_from: null,
      superseded_by: null,
      modalities: ['text'],
      model_type: ['dense'],
      citation: null,
      contacts: null,
      experiment_kwargs: null,
      output_dtypes: null,
      extra_requirements_groups: null,
      loader: null,
      is_cross_encoder: false,
    };

    const dict = ModelMeta.createEmpty().toDict();

    assert.deepEqual(dict, expected);
    assert.deepEqual(Object.keys(dict), Object.keys(expected));
  });

  test('toDict gives the largest dimension of a Matryoshka model, the training datasets as a list and the loader by name', () => {
    // toDict writes only the name of the loader; the test never calls it.
    function loadMyModel(): never {
      throw new Error('The test does not load the model.');
    }
    const meta = ModelMeta.createEmpty({
      name: 'a/b',
      revision: 'x',
      embedDim: [256, 768],
      trainingDatasets: new Set(['B', 'A']),
      similarityFnName: ScoringFunction.COSINE,
      loader: loadMyModel,
    });

    const dict = meta.toDict();

    assert.equal(dict['embed_dim'], 768);
    // Python's set has no order; this port keeps the order of insertion.
    assert.deepEqual(dict['training_datasets'], ['B', 'A']);
    assert.equal(dict['similarity_fn_name'], 'cosine');
    assert.equal(dict['loader'], 'loadMyModel');
  });

  test('fromDict reads a model_meta.json that MTEB wrote, with the loader by name and is_cross_encoder', () => {
    const json = {
      loader_kwargs: {},
      name: 'llama.cpp/embeddinggemma-2',
      revision: '58faf90940886df2d62be555c8765d00dac362c5-Q8_0',
      release_date: null,
      languages: null,
      n_parameters: null,
      n_active_parameters_override: null,
      n_embedding_parameters: null,
      memory_usage_mb: null,
      max_tokens: null,
      embed_dim: null,
      license: null,
      open_weights: null,
      public_training_code: null,
      public_training_data: null,
      framework: [],
      reference: null,
      similarity_fn_name: null,
      use_instructions: null,
      training_datasets: null,
      adapted_from: null,
      superseded_by: null,
      modalities: ['text'],
      model_type: ['dense'],
      citation: null,
      contacts: null,
      experiment_kwargs: null,
      output_dtypes: null,
      extra_requirements_groups: null,
      loader: 'SiglipModelWrapper',
      is_cross_encoder: false,
    };

    const meta = ModelMeta.fromDict(json);

    assert.equal(meta.name, 'llama.cpp/embeddinggemma-2');
    assert.equal(meta.loader, null);
    assert.deepEqual(meta.modelType, ['dense']);
    assert.deepEqual(meta.toDict(), { ...json, loader: null });
  });

  test('with validate false, the constructor takes the input as it is and fills the defaults, as pydantic model_construct', () => {
    const meta = new ModelMeta(
      { ...REQUIRED, name: 'not-an-org-name', trainingDatasets: ['A'] },
      { validate: false },
    );

    assert.equal(meta.name, 'not-an-org-name');
    assert.deepEqual(meta.trainingDatasets, new Set(['A']));
    assert.deepEqual(meta.modelType, ['dense']);
    assert.deepEqual(meta.modalities, ['text']);
    assert.deepEqual(meta.loaderKwargs, {});
  });

  test('createEmpty does not validate its overwrites, as pydantic model_copy', () => {
    const meta = ModelMeta.createEmpty({ name: 'no-slash' });

    assert.equal(meta.name, 'no-slash');
    assert.equal(meta.revision, 'no_revision_available');
  });

  test('merge keeps a real name and takes the lists of the overwrite, as MTEB does', () => {
    const base = ModelMeta.createEmpty({
      name: 'a/b',
      framework: ['API'],
      modelType: ['dense'],
    });
    const overwrite = ModelMeta.createEmpty({
      framework: ['PyTorch'],
      modelType: ['sparse'],
      embedDim: 5,
    });

    const merged = base.merge(overwrite);

    assert.equal(merged.name, 'a/b');
    assert.equal(merged.revision, 'no_revision_available');
    assert.deepEqual(merged.framework, ['PyTorch']);
    assert.deepEqual(merged.modelType, ['sparse']);
    assert.equal(merged.embedDim, 5);
  });

  test('the model name as a path and with its experiment', () => {
    const meta = ModelMeta.createEmpty({
      name: 'org/some model',
      revision: 'r1',
      experimentKwargs: { param1: 'value1' },
    });

    assert.equal(meta.modelNameAsPath(), 'org__some_model');
    assert.equal(meta.experimentName, 'param1_value1');
    assert.equal(
      meta.modelNameWithExperiment,
      'org/some model (param1=value1)',
    );
    assert.throws(
      () => ModelMeta.createEmpty().modelCopy({ name: null }).modelNameAsPath(),
      /Model name is not set/u,
    );
  });
});

// The keyword arguments of a search model that takes options of its own and
// no AI SDK model, as MTEB's BM25.
type SearchKwargs = LoadKwargs & {
  readonly k1?: number;
  readonly model?: never;
};

describe('ModelMeta.loadModel', () => {
  test('an encoder does not load without its AI SDK model, and a search model does not take one', () => {
    const search = new ModelMeta<SearchKwargs, SearchProtocol>({
      ...REQUIRED,
      name: 'test/search',
      loader: (_name, _revision, { modelMeta }) => ({
        index: async () => {},
        search: async () => new Map(),
        mtebModelMeta: modelMeta,
      }),
    });
    // A function that is never called: the type checker reads it.
    const loads = (model: EmbeddingModelV4) => [
      // @ts-expect-error an encoder needs the AI SDK model that serves it.
      qwen3Embedding0B6.loadModel(),
      // @ts-expect-error a search model takes no AI SDK model.
      search.loadModel({ model }),
    ];

    assert.equal(typeof loads, 'function');
  });

  test('a search model loads with the experiment arguments in its metadata, as MTEB does', () => {
    const received: LoaderOptions<SearchKwargs>[] = [];
    const meta = new ModelMeta<SearchKwargs, SearchProtocol>({
      ...REQUIRED,
      name: 'test/search',
      revision: 'r1',
      loader: (_name, _revision, options) => {
        received.push(options);
        return {
          index: async () => {},
          search: async () => new Map(),
          mtebModelMeta: options.modelMeta,
        };
      },
    });

    const plain = meta.loadModel();
    const tuned = meta.loadModel({ k1: 1.2 });

    assert.equal(plain.mtebModelMeta.name, 'test/search');
    assert.equal(plain.mtebModelMeta.experimentKwargs, null);
    assert.deepEqual(tuned.mtebModelMeta.experimentKwargs, { k1: 1.2 });
    assert.deepEqual(tuned.mtebModelMeta.loaderKwargs, { k1: 1.2 });
    assert.equal(tuned.mtebModelMeta.experimentName, 'k1_1.2');
    assert.equal(received[1]?.k1, 1.2);
    assert.equal(meta.experimentKwargs, null);
  });

  test('a metadata without a loader cannot load a model, as MTEB raises', () => {
    const meta = ModelMeta.createEmpty({ name: 'test/empty' });

    assert.throws(
      // @ts-expect-error a metadata without a loader takes no keyword arguments.
      () => meta.loadModel(),
      /No model implementation is available for this model\./u,
    );
  });
});

describe('serializeExperimentKwargsToName', () => {
  test('gives the names that MTEB gives', () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ param1: 'value1' }, 'param1_value1', 'param1=value1'],
      [{ b: 1, a: 'x' }, 'a_x__b_1', 'a=x, b=1'],
      [
        { lr: 0.1, flag: true, none: null },
        'flag_True__lr_0.1__none_None',
        'flag=True, lr=0.1, none=None',
      ],
      [{ path: 'a/b:c' }, 'path_a_b_c', 'path=a_b_c'],
      [
        { lst: [1, 'two', [3.5, false]] },
        'lst_[1,two,[3.5,False]]',
        'lst=[1,two,[3.5,False]]',
      ],
      [{ d: { z: 1, a: 2 } }, 'exp_2613e2056f05b86a', 'exp_4fe6c7790c1c71a5'],
      [
        { long: 'x'.repeat(250) },
        'exp_6398e120c3210f97',
        'exp_a759c9007353bdc8',
      ],
      [{ unicode: 'café' }, 'unicode_café', 'unicode=café'],
    ];

    for (const [kwargs, name, label] of cases) {
      assert.equal(serializeExperimentKwargsToName(kwargs), name);
      assert.equal(serializeExperimentKwargsToName(kwargs, '=', ', '), label);
    }
  });

  test('writes floats as Python writes them and sorts keys by code point', () => {
    assert.equal(
      serializeExperimentKwargsToName({
        f: 1e-5,
        x: 1.5e-7,
        y: 1234.5,
        n: -0.25,
      }),
      'f_1e-05__n_-0.25__x_1.5e-07__y_1234.5',
    );
    assert.equal(
      serializeExperimentKwargsToName({ émoji: '🙂', a: 'x' }),
      'a_x__émoji_🙂',
    );
  });

  test('gives null without parameters', () => {
    assert.equal(serializeExperimentKwargsToName(null), null);
    assert.equal(serializeExperimentKwargsToName({}), null);
  });

  test('a whole number is a Python int, so 1.0 gives "1" where MTEB gives "1.0"', () => {
    assert.equal(serializeExperimentKwargsToName({ h: 123 }), 'h_123');
  });

  test('throws for a value that has no deterministic name', () => {
    assert.throws(
      () => serializeExperimentKwargsToName({ when: new Date(0) }),
      /experiment_kwargs contains non-serializable type Date/u,
    );
  });
});

describe('mergePrecisionIntoExperimentKwargs', () => {
  test('folds the precision into output_dtypes, and keeps the kwargs without one', () => {
    assert.deepEqual(
      mergePrecisionIntoExperimentKwargs(null, { precision: 'int8' }),
      { output_dtypes: 'int8' },
    );
    assert.deepEqual(mergePrecisionIntoExperimentKwargs({ a: 1 }, {}), {
      a: 1,
    });
    assert.throws(
      () => mergePrecisionIntoExperimentKwargs(null, { precision: 'int3' }),
      /'int3' is not a valid OutputDType value/u,
    );
  });
});
