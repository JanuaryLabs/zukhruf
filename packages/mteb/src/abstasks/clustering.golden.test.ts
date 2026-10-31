import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { EmbeddingModelV4 } from '@ai-sdk/provider';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { log } from '../dependencies/libm.ts';
import { PythonRandom } from '../dependencies/python-random.ts';
import { isPlainObject } from '../dependencies/python.ts';
import { MiniBatchKMeans } from '../dependencies/sklearn-kmeans.ts';
import {
  type ClusterLabel,
  adjustedMutualInfoScore,
  homogeneityCompletenessVMeasure,
  vMeasureScore,
} from '../dependencies/sklearn.ts';
import { evaluate } from '../evaluate.ts';
import { AiSdkEncoder } from '../models/ai-sdk-encoder.ts';
import { ModelMeta } from '../models/model-meta.ts';
import {
  BiorxivClusteringS2S,
  BiorxivClusteringS2SFast,
} from '../tasks/clustering/eng/biorxiv-clustering-s2s.ts';
import type { AbsTask } from './abstask.ts';
import { AbsTaskClusteringLegacy } from './clustering-legacy.ts';
import {
  AbsTaskClustering,
  evaluateClusteringBootstrapped,
} from './clustering.ts';
import { TaskMetadata } from './task-metadata.ts';

// fixtures/clustering/expected.json holds what Python MTEB 2.26.28
// (scikit-learn 1.9.1, numpy 2.5.4, SciPy 1.18.1, torch 2.14.1, CPython
// 3.12.9 on macOS arm64) gave for three folder tasks with an encoder that
// reads each text as a vector, and for slices of BiorxivClusteringS2S.v2 and
// BiorxivClusteringS2S (fixtures/clustering/hub, in the cache layout of
// dependencies/datasets.ts) with an encoder that counts code points: the
// scores of mteb.evaluate and its predictions file. It also holds the
// cluster metrics of scikit-learn for label arrays, MiniBatchKMeans for data
// made in generate.py, and math.log of the integers 1 to 16384. generate.py
// makes it.
const FOLDER = join(import.meta.dirname, 'fixtures/clustering');

type TaskRun = {
  readonly scores: { readonly test: unknown[] };
  readonly predictions: unknown;
};

type Expected = {
  readonly code_point_dim: number;
  readonly tasks: Readonly<
    Record<
      'folder' | 'strings' | 'legacy' | 'biorxiv_v2' | 'biorxiv_legacy',
      TaskRun
    >
  >;
  readonly metric_cases: readonly {
    readonly case: string;
    readonly labels_true: ClusterLabel[];
    readonly labels_pred: ClusterLabel[];
    readonly homogeneity: number;
    readonly completeness: number;
    readonly v_measure: number;
    readonly ami: number;
  }[];
  readonly kmeans_cases: readonly {
    readonly case: string;
    readonly x: number[][];
    readonly n_clusters: number;
    readonly batch_size: number;
    readonly n_init: 1 | 'auto';
    readonly labels: number[];
    readonly centers: number[][];
    readonly n_steps: number;
  }[];
  readonly log: {
    readonly values: string;
    readonly misrounded: readonly {
      readonly x: number;
      readonly correctly_rounded: number;
    }[];
  };
};

const expected: Expected = JSON.parse(
  readFileSync(join(FOLDER, 'expected.json'), 'utf8'),
);

// AMI_TOLERANCE * max(1, |value|) bounds the difference of an adjusted
// mutual information. Its expected mutual information adds exp of sums of
// log-gamma values near 1e5, which MTEB takes from the C library (lgamma,
// exp) and SciPy (gammaln), and this port from the lgam of the npm package
// cephes and Math.exp. The largest difference seen is 2.6e-14, for 4096 samples of
// 26 classes in 20 clusters; in evaluate it is 1.0e-14.
const AMI_TOLERANCE = 1e-12;

function assertClose(
  actual: unknown,
  python: unknown,
  tolerance: number,
  name: string,
): void {
  assert.equal(typeof actual, 'number', name);
  assert.equal(typeof python, 'number', name);
  const difference = Math.abs(Number(actual) - Number(python));
  assert.ok(
    difference <= tolerance * Math.max(1, Math.abs(Number(python))),
    `${name}: ${actual} and ${python}`,
  );
}

// The entries of a JSON object.
function entriesOf(value: unknown): [string, unknown][] {
  assert.ok(isPlainObject(value), `${String(value)} is not an object`);
  return Object.entries(value);
}

// A JSON list of numbers.
function numbersOf(value: unknown): number[] {
  assert.ok(Array.isArray(value), `${String(value)} is not a list`);
  return value.map((item: unknown) => {
    assert.equal(typeof item, 'number');
    return Number(item);
  });
}

// The scores of evaluate: the AMI values within AMI_TOLERANCE, the rest to
// the last bit.
function assertScores(actual: unknown, python: unknown) {
  const own = new Map(entriesOf(actual));
  const entries = entriesOf(python);
  assert.deepEqual(
    [...own.keys()],
    entries.map(([name]) => name),
  );
  for (const [name, value] of entries) {
    if (name === 'ami_scores') {
      const levels = entriesOf(value);
      const ownLevels = new Map(entriesOf(own.get(name)));
      assert.deepEqual(
        [...ownLevels.keys()],
        levels.map(([level]) => level),
      );
      for (const [level, runs] of levels) {
        const ownRuns = numbersOf(ownLevels.get(level));
        numbersOf(runs).forEach((run, index) =>
          assertClose(
            ownRuns[index],
            run,
            AMI_TOLERANCE,
            `${name} ${level} ${index}`,
          ),
        );
      }
    } else if (name === 'ami' || name === 'ami_std')
      assertClose(own.get(name), value, AMI_TOLERANCE, name);
    else assert.deepEqual(own.get(name), value, name);
  }
}

function vectorEncoder(): AiSdkEncoder {
  const model: EmbeddingModelV4 = {
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
  return new AiSdkEncoder({
    model,
    modelMeta: ModelMeta.createEmpty({ name: 'test/vector', revision: '1' }),
  });
}

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

function fixtureMetadata(name: string, folder: string): TaskMetadata {
  return new TaskMetadata({
    name,
    description: 'The clustering fixture of @zukhruf/mteb.',
    dataset: { path: join(FOLDER, folder), revision: '1' },
    type: 'Clustering',
    category: 't2c',
    modalities: ['text'],
    evalSplits: ['test'],
    evalLangs: ['eng-Latn'],
    mainScore: 'v_measure',
  });
}

// The folder task of generate.py: int labels at two levels, half the
// documents embedded, 3 runs of 1000 samples.
class FolderTask extends AbsTaskClustering {
  override maxFractionOfDocumentsToEmbed = 0.5;
  override maxDocumentsPerCluster = 1000;
  override nClusters = 3;

  constructor() {
    super({ metadata: fixtureMetadata('ClusteringFixture', 'folder') });
  }
}

// The strings task of generate.py: string labels at two levels, 30
// documents embedded, 2 runs of 500 samples.
class StringsTask extends AbsTaskClustering {
  override maxFractionOfDocumentsToEmbed = null;
  override maxDocumentToEmbed = 30;
  override maxDocumentsPerCluster = 500;
  override nClusters = 2;

  constructor() {
    super({ metadata: fixtureMetadata('ClusteringStringsFixture', 'strings') });
  }
}

class LegacyTask extends AbsTaskClusteringLegacy {
  constructor() {
    super({ metadata: fixtureMetadata('ClusteringLegacyFixture', 'legacy') });
  }
}

// The Hub slices are read from the cache. An endpoint that refuses
// connections fails the test if a task reaches for the network.
const HUB = {
  hub: { cacheFolder: join(FOLDER, 'hub'), endpoint: 'http://127.0.0.1:9' },
};

// The predictions of a v2 task as generate.py keeps them: each run of
// cluster labels as a string of base-36 digits.
function compact(predictions: unknown): unknown {
  return Object.fromEntries(
    entriesOf(predictions)
      .filter(([subset]) => subset !== 'mteb_model_meta')
      .map(([subset, splits]) => [
        subset,
        Object.fromEntries(
          entriesOf(splits).map(([split, levels]) => [
            split,
            Object.fromEntries(
              entriesOf(levels).map(([level, runs]) => {
                assert.ok(Array.isArray(runs));
                return [
                  level,
                  runs.map((run: unknown) =>
                    numbersOf(run)
                      .map((label) => label.toString(36).toUpperCase())
                      .join(''),
                  ),
                ];
              }),
            ),
          ]),
        ),
      ]),
  );
}

const TASKS: readonly {
  readonly key: keyof Expected['tasks'];
  readonly title: string;
  readonly task: () => AbsTask;
  readonly encoder: () => AiSdkEncoder;
  readonly v2: boolean;
}[] = [
  {
    key: 'folder',
    title: 'the folder task with int labels at two levels',
    task: () => new FolderTask(),
    encoder: vectorEncoder,
    v2: true,
  },
  {
    key: 'strings',
    title: 'the folder task with string labels, where a missing level is "-1"',
    task: () => new StringsTask(),
    encoder: vectorEncoder,
    v2: true,
  },
  {
    key: 'legacy',
    title: 'the legacy folder task of three sets',
    task: () => new LegacyTask(),
    encoder: vectorEncoder,
    v2: false,
  },
  {
    key: 'biorxiv_v2',
    title: 'BiorxivClusteringS2S.v2 on its slice',
    task: () => new BiorxivClusteringS2SFast(HUB),
    encoder: codePointEncoder,
    v2: true,
  },
  {
    key: 'biorxiv_legacy',
    title: 'BiorxivClusteringS2S on its slice',
    task: () => new BiorxivClusteringS2S(HUB),
    encoder: codePointEncoder,
    v2: false,
  },
];

for (const { key, title, task, encoder, v2 } of TASKS)
  test(`evaluate gives ${title} the cluster labels and the V-measures of MTEB to the last bit, and the AMI within ${AMI_TOLERANCE}`, async () => {
    await using folder = await new TemporaryFiles().directory(
      'clustering-predictions-',
    );
    const subject = task();

    const result = await evaluate(encoder(), subject, {
      cache: null,
      predictionFolder: folder.path,
    });

    const python = expected.tasks[key];
    const predictions: unknown = JSON.parse(
      readFileSync(join(folder.path, subject.predictionFileName), 'utf8'),
    );
    assert.deepEqual(
      v2 ? compact(predictions) : predictions,
      python.predictions,
    );
    assertScores(
      result.taskResults[0]?.scores['test']?.[0],
      python.scores.test[0],
    );
  });

for (const metricCase of expected.metric_cases)
  test(`the V-measure of "${metricCase.case}" equals scikit-learn's to the last bit, and the AMI is within ${AMI_TOLERANCE}`, () => {
    const labelsTrue = metricCase.labels_true;
    const labelsPred = metricCase.labels_pred;

    const scores = homogeneityCompletenessVMeasure(labelsTrue, labelsPred);
    const vMeasure = vMeasureScore(labelsTrue, labelsPred);
    const ami = adjustedMutualInfoScore(labelsTrue, labelsPred);

    assert.deepEqual(
      [...scores, vMeasure],
      [
        metricCase.homogeneity,
        metricCase.completeness,
        metricCase.v_measure,
        metricCase.v_measure,
      ],
    );
    assertClose(ami, metricCase.ami, AMI_TOLERANCE, 'ami');
  });

// CENTER_TOLERANCE * max(1, |value|) bounds the difference of a cluster
// center. With the same labels at each step, the centers are equal to the
// last bit: the largest difference seen is 0. A center can differ when a
// distance of BLAS and of this port round to other float32 values.
const CENTER_TOLERANCE = 2 ** -20;

for (const kmeansCase of expected.kmeans_cases)
  test(`MiniBatchKMeans of "${kmeansCase.case}" gives the labels and steps of scikit-learn, and centers within ${CENTER_TOLERANCE}`, () => {
    const x = kmeansCase.x.map((row) => Float32Array.from(row));
    const model = new MiniBatchKMeans({
      nClusters: kmeansCase.n_clusters,
      batchSize: kmeansCase.batch_size,
      nInit: kmeansCase.n_init,
      randomState: 42,
    });

    model.fit(x);

    assert.deepEqual(model.labels, kmeansCase.labels);
    assert.equal(model.nSteps, kmeansCase.n_steps);
    assert.equal(model.clusterCenters.length, kmeansCase.centers.length);
    kmeansCase.centers.forEach((center, cluster) =>
      center.forEach((value, feature) =>
        assertClose(
          model.clusterCenters[cluster]?.[feature],
          value,
          CENTER_TOLERANCE,
          `center ${cluster} ${feature}`,
        ),
      ),
    );
  });

test('MiniBatchKMeans throws for fewer samples than clusters, as scikit-learn raises', () => {
  const model = new MiniBatchKMeans({ nClusters: 3, randomState: 42 });

  assert.throws(
    () => model.fit([new Float32Array([1]), new Float32Array([2])]),
    {
      message: 'n_samples=2 should be >= n_clusters=3.',
    },
  );
});

// MTEB 2.26.28 with CPython 3.12.9 raised IndexError('range object index out
// of range') for these labels: no sample has a label at the second level, so
// rng_state.choices draws from range(0).
test('a level where no sample has a label throws the IndexError of MTEB', () => {
  const labels = [
    [0, -1],
    [1, -1],
    [0, -1],
    [1, -1],
  ];
  const embeddings = labels.map(
    (_, index) => new Float32Array([index === 0 ? 1 : 0, index === 1 ? 1 : 0]),
  );

  assert.throws(
    () =>
      evaluateClusteringBootstrapped(embeddings, labels, {
        nClusters: 2,
        clusterSize: 3,
        kmeanBatchSize: 512,
        maxDepth: null,
        rngState: new PythonRandom(42),
        seed: 42,
      }),
    { message: 'IndexError: range object index out of range' },
  );
});

test("log equals the log of Python for the integers 1 to 16384, except where macOS's log is not correctly rounded", () => {
  const python = new Float64Array(
    Buffer.from(expected.log.values, 'base64').buffer.slice(0),
  );
  const misrounded = new Map(
    expected.log.misrounded.map(({ x, correctly_rounded }) => [
      x,
      correctly_rounded,
    ]),
  );

  const differences = Array.from(python, (value, index) => [
    index + 1,
    log(index + 1),
    value,
  ]).filter(([, own, value]) => own !== value);

  assert.deepEqual(
    differences.map(([x, own]) => [x, own]),
    [...misrounded],
  );
});
