import {
  type Dataset,
  type DatasetValue,
  datasetFromDict,
} from '../dependencies/datasets.ts';
import { mean, std } from '../dependencies/numpy.ts';
import { type ClusterLabel, vMeasureScore } from '../dependencies/sklearn.ts';
import { ClusteringEvaluator } from '../evaluators/clustering-evaluator.ts';
import { isEncoder } from '../models/models-protocols.ts';
import type { TimingStack } from '../timing.ts';
import type { EncodeKwargs } from '../types/encoder-io.ts';
import type { Score } from '../types/result.ts';
import { AbsTask, type MTEBModels } from './abstask.ts';

// mteb/abstasks/clustering_legacy.py, for text: each row of a split is a set
// of inputs to cluster, with a list of inputs and a list of labels. Other
// modalities, whose split is one set with the NMI, ARI and cluster accuracy
// too, the descriptive statistics and the push to the Hub are not ported.
export abstract class AbsTaskClusteringLegacy extends AbsTask<Dataset> {
  inputColumnName = 'sentences';
  labelColumnName = 'labels';

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
        'Expected model to be an instance of EncoderProtocol',
      );
    const columns = [this.inputColumnName, this.labelColumnName];
    for (const column of columns)
      if (!dataSplit.columnNames.includes(column))
        throw new Error(
          `Column name ['${column}'] not in the dataset. Current columns in the dataset: [${dataSplit.columnNames.map((name) => `'${name}'`).join(', ')}].`,
        );
    const modalities = this.metadata.modalities;
    if (modalities.length !== 1 || modalities[0] !== 'text')
      throw new Error(
        `The ${modalities.join(', ')} modality is not supported yet.`,
      );
    const vMeasures: number[] = [];
    const clusters: number[][] = [];
    for (const clusterSet of dataSplit.rows) {
      const labels = labelsOf(clusterSet[this.labelColumnName]);
      if (new Set(labels).size <= 1) {
        vMeasures.push(1);
        continue;
      }
      const clusteringDataset = datasetFromDict(
        Object.fromEntries(
          columns.map((column) => [column, clusterSet[column] ?? null]),
        ),
      );
      const evaluator = new ClusteringEvaluator(clusteringDataset, {
        inputColumnName: this.inputColumnName,
        labelColumnName: this.labelColumnName,
        taskMetadata: this.metadata,
        hfSplit: options.hfSplit,
        hfSubset: options.hfSubset,
        timer: options.timer,
      });
      const clustersAssignment = await evaluator.call(
        model,
        options.encodeKwargs,
      );
      clusters.push(clustersAssignment);
      vMeasures.push(vMeasureScore(labels, clustersAssignment));
    }
    if (options.predictionFolder !== null)
      this.saveTaskPredictions(
        clusters,
        model,
        options.predictionFolder,
        options.hfSplit,
        options.hfSubset,
      );
    return {
      v_measure: mean(vMeasures),
      v_measure_std: std(vMeasures),
      v_measures: vMeasures,
    };
  }
}

function labelsOf(value: DatasetValue | undefined): ClusterLabel[] {
  if (!Array.isArray(value))
    throw new TypeError('The labels of a cluster set must be a list.');
  return value.map((label: DatasetValue) => {
    if (typeof label === 'string' || typeof label === 'number') return label;
    throw new TypeError(
      `A cluster label must be a string or a number, not ${String(label)}.`,
    );
  });
}
