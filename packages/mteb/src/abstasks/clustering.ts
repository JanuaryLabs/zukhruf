import { createDataloaderFromTexts } from '../create-dataloaders.ts';
import type { Dataset, DatasetValue } from '../dependencies/datasets.ts';
import { mean, std } from '../dependencies/numpy.ts';
import { PythonRandom } from '../dependencies/python-random.ts';
import { MiniBatchKMeans } from '../dependencies/sklearn-kmeans.ts';
import {
  type ClusterLabel,
  adjustedMutualInfoScore,
  vMeasureScore,
} from '../dependencies/sklearn.ts';
import { isEncoder } from '../models/models-protocols.ts';
import type { TimingStack } from '../timing.ts';
import type { Embeddings, EncodeKwargs } from '../types/encoder-io.ts';
import type { Score } from '../types/result.ts';
import { AbsTask, type MTEBModels } from './abstask.ts';

// mteb/abstasks/clustering.py, for text. The descriptive statistics, the push
// to the Hub and _convert_to_fast are not ported.

type MetricName = 'v_measure' | 'ami';

const METRICS: readonly (readonly [MetricName, typeof vMeasureScore])[] = [
  ['v_measure', vMeasureScore],
  ['ami', adjustedMutualInfoScore],
];

type LevelScores = Map<string, number[]>;

// _evaluate_clustering_bootstrapped: for each level of the labels, nClusters
// runs of MiniBatchKMeans, each on clusterSize samples drawn with
// replacement by rngState.choices. A sample without a label at a level is
// left out of that level when its labels are numbers. With string labels,
// numpy turns the missing label -1 into the string "-1", so the sample stays
// in the level with the label "-1", as in MTEB.
export function evaluateClusteringBootstrapped(
  embeddings: Embeddings,
  labels: readonly (readonly ClusterLabel[])[],
  options: {
    readonly nClusters: number;
    readonly clusterSize: number;
    readonly kmeanBatchSize: number;
    readonly maxDepth: number | null;
    readonly rngState: PythonRandom;
    readonly seed: number;
  },
): {
  readonly scores: Record<MetricName, LevelScores>;
  readonly clusterAssignments: Map<string, number[][]>;
} {
  const scores: Record<MetricName, LevelScores> = {
    v_measure: new Map(),
    ami: new Map(),
  };
  const clusterAssignments = new Map<string, number[][]>();
  const deepest = labels.reduce(
    (largest, label) => Math.max(largest, label.length),
    -Infinity,
  );
  const maxDepth =
    options.maxDepth === null ? deepest : Math.min(options.maxDepth, deepest);
  for (let level = 0; level < maxDepth; level++) {
    let levelLabels: ClusterLabel[] = labels.map((label) => label[level] ?? -1);
    const strings = levelLabels.some((label) => typeof label === 'string');
    if (strings) levelLabels = levelLabels.map(String);
    const valid = levelLabels.map((label) => label !== -1);
    levelLabels = levelLabels.filter((_, index) => valid[index]);
    const levelEmbeddings = embeddings.filter((_, index) => valid[index]);
    const clusteringModel = new MiniBatchKMeans({
      nClusters: new Set(levelLabels).size,
      batchSize: options.kmeanBatchSize,
      nInit: 1,
      randomState: options.seed,
    });
    const name = `Level ${level}`;
    for (let run = 0; run < options.nClusters; run++) {
      const clusterIndices = options.rngState.choices(
        levelEmbeddings.length,
        options.clusterSize,
      );
      const clusterAssignment = clusteringModel.fitPredict(
        clusterIndices.map(
          (index) => levelEmbeddings[index] ?? new Float32Array(),
        ),
      );
      const sampledLabels = clusterIndices.map(
        (index) => levelLabels[index] ?? -1,
      );
      for (const [metric, score] of METRICS) {
        const byLevel = scores[metric];
        byLevel.set(name, [
          ...(byLevel.get(name) ?? []),
          score(sampledLabels, clusterAssignment),
        ]);
      }
      clusterAssignments.set(name, [
        ...(clusterAssignments.get(name) ?? []),
        clusterAssignment,
      ]);
    }
  }
  return { scores, clusterAssignments };
}

// A clustering task: each input has a label, or a list of labels for the
// levels of a hierarchy. The task embeds a sample of the inputs, then
// clusters nClusters samples of the embeddings with MiniBatchKMeans and
// compares the clusters with the labels by the V-measure and the adjusted
// mutual information.
export abstract class AbsTaskClustering extends AbsTask<Dataset> {
  maxFractionOfDocumentsToEmbed: number | null = 0.04;
  maxDocumentToEmbed: number | null = null;
  maxDocumentsPerCluster = 16_384;
  nClusters = 10;
  kMeanBatchSize = 512;
  maxDepth: number | null = null;
  inputColumnName = 'sentences';
  labelColumnName = 'labels';
  // MTEB's AbsTask seeds rng_state with the seed of the task. Only the
  // clustering tasks draw from it, so it lives here.
  protected readonly rngState = new PythonRandom(this.seed);

  override get abstaskPrompt(): string {
    return 'Identify categories in user passages.';
  }

  protected override loadSplits() {
    return this.loadDatasets();
  }

  protected override async evaluateSubset(
    model: MTEBModels,
    dataSplit: Dataset,
    options: {
      readonly hfSplit: string;
      readonly hfSubset: string;
      readonly encodeKwargs: EncodeKwargs;
      readonly predictionFolder: string | null;
      readonly timer: TimingStack;
    },
  ): Promise<Record<string, Score>> {
    if (!isEncoder(model))
      throw new TypeError(
        'Expected encoder model to be an instance of EncoderProtocol.',
      );
    if (
      this.maxDocumentToEmbed !== null &&
      this.maxFractionOfDocumentsToEmbed !== null
    )
      throw new Error(
        'Both max_document_to_embed and max_fraction_of_documents_to_embed are set. Please only set one.',
      );
    let rows = dataSplit.rows;
    if (
      this.maxDocumentToEmbed !== null ||
      this.maxFractionOfDocumentsToEmbed !== null
    ) {
      const maxDocumentsToEmbed = Math.min(
        rows.length,
        this.maxFractionOfDocumentsToEmbed === null
          ? (this.maxDocumentToEmbed ?? 0)
          : Math.trunc(this.maxFractionOfDocumentsToEmbed * rows.length),
      );
      const exampleIndices = this.rngState.sample(
        rows.length,
        maxDocumentsToEmbed,
      );
      rows = exampleIndices.map((index) => dataSplit.rows[index] ?? {});
    }
    const missing = [this.inputColumnName, this.labelColumnName].filter(
      (column) => !dataSplit.columnNames.includes(column),
    );
    if (missing.length > 0)
      throw new Error(
        `Missing required columns in dataset: ${missing.join(', ')}. Available columns: ${dataSplit.columnNames.join(', ')}`,
      );
    const location = { split: options.hfSplit, subset: options.hfSubset };
    const { modalities } = this.metadata;
    if (modalities.length !== 1 || modalities[0] !== 'text')
      throw new Error(
        `The ${modalities.join(', ')} modality is not supported yet.`,
      );
    let embeddings: Embeddings;
    {
      using _ = options.timer.phase('Encoding', location);
      embeddings = await model.encode(
        createDataloaderFromTexts(
          rows.map((row) => String(row[this.inputColumnName])),
          { batchSize: options.encodeKwargs.batchSize ?? 32 },
        ),
        {
          ...options.encodeKwargs,
          taskMetadata: this.metadata,
          hfSplit: options.hfSplit,
          hfSubset: options.hfSubset,
          promptType: null,
        },
      );
    }
    const labels = rows.map((row) => labelList(row[this.labelColumnName]));
    let result: ReturnType<typeof evaluateClusteringBootstrapped>;
    {
      using _ = options.timer.phase('Scoring', location);
      result = evaluateClusteringBootstrapped(embeddings, labels, {
        nClusters: this.nClusters,
        clusterSize: this.maxDocumentsPerCluster,
        kmeanBatchSize: this.kMeanBatchSize,
        maxDepth: this.maxDepth,
        rngState: this.rngState,
        seed: this.seed,
      });
    }
    if (options.predictionFolder !== null)
      this.saveTaskPredictions(
        Object.fromEntries(result.clusterAssignments),
        model,
        options.predictionFolder,
        options.hfSplit,
        options.hfSubset,
      );
    const scores: Record<string, Score> = {};
    for (const [metric, byLevel] of Object.entries(result.scores)) {
      const flat = [...byLevel.values()].flat();
      scores[metric === 'v_measure' ? 'v_measures' : `${metric}_scores`] =
        Object.fromEntries(byLevel);
      scores[metric] = mean(flat);
      scores[`${metric}_std`] = std(flat);
    }
    return scores;
  }
}

// The labels of an input: a list, or one label.
function labelList(value: DatasetValue | undefined): ClusterLabel[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((label: DatasetValue | undefined) => {
    if (typeof label === 'string' || typeof label === 'number') return label;
    throw new TypeError(
      `A cluster label must be a string or a number, not ${String(label)}.`,
    );
  });
}

// _check_label_distribution. MTEB checks that the labels of each row are
// among the labels of all rows, which they always are. What can fail is the
// iteration over the labels of a row: for at most 50 rows, a label that is
// not a string or a list throws, as Python raises a TypeError. A string
// counts as its characters.
export function checkLabelDistribution(
  dataset: Dataset,
  labelColumnName = 'labels',
): void {
  if (dataset.rows.length > 50) return;
  for (const row of dataset.rows) {
    const value = row[labelColumnName];
    if (typeof value !== 'string' && !Array.isArray(value))
      throw new TypeError(
        `'${value === null ? 'NoneType' : typeof value}' object is not iterable`,
      );
  }
}
