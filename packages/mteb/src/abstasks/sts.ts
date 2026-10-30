import type { Dataset, DatasetValue } from '../dependencies/datasets.ts';
import { pearsonr, spearmanr } from '../dependencies/scipy.ts';
import {
  AnySTSEvaluator,
  type STSEvaluatorScores,
} from '../evaluators/any-sts-evaluator.ts';
import { isEncoder } from '../models/models-protocols.ts';
import type { TimingStack } from '../timing.ts';
import type { EncodeKwargs, PromptType } from '../types/encoder-io.ts';
import type { HFSubset, Score } from '../types/result.ts';
import { AbsTask, type MTEBModels } from './abstask.ts';

// mteb/abstasks/sts.py, for text. The descriptive statistics and the push to
// the Hub are not ported.

// The Pearson and Spearman correlations of each score with the gold scores.
// pearson and spearman use the similarity of the model.
export type STSMetrics = {
  readonly pearson: number;
  readonly spearman: number;
  readonly cosine_pearson: number;
  readonly cosine_spearman: number;
  readonly manhattan_pearson: number;
  readonly manhattan_spearman: number;
  readonly euclidean_pearson: number;
  readonly euclidean_spearman: number;
};

// A semantic textual similarity task: each pair of inputs has a gold score
// from minScore to maxScore. The metrics measure how well each score of the
// pairs (the cosine similarity, the negated distances and the similarity of
// the model) correlates with the gold scores.
export abstract class AbsTaskSTS extends AbsTask<Dataset> {
  columnNames: readonly [string, string] = ['sentence1', 'sentence2'];
  minScore = 0;
  maxScore = 5;
  input1PromptType: PromptType | null = null;
  input2PromptType: PromptType | null = null;

  override get abstaskPrompt(): string {
    return 'Retrieve semantically similar text.';
  }

  protected override loadSplits(): Promise<
    Map<HFSubset, Map<string, Dataset>>
  > {
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
    const normalizedScores = dataSplit.rows.map((row) =>
      this.normalize(goldScore(row['score'])),
    );
    const evaluator = new AnySTSEvaluator(dataSplit, this.columnNames, {
      taskMetadata: this.metadata,
      hfSplit: options.hfSplit,
      hfSubset: options.hfSubset,
      input1PromptType: this.input1PromptType,
      input2PromptType: this.input2PromptType,
      timer: options.timer,
    });
    const scores = await evaluator.call(model, options.encodeKwargs);
    if (options.predictionFolder !== null)
      this.saveTaskPredictions(
        {
          cosine_scores: scores.cosineScores,
          manhattan_distances: scores.manhattanDistances,
          euclidean_distances: scores.euclideanDistances,
          similarity_scores: scores.similarityScores,
        },
        model,
        options.predictionFolder,
        options.hfSplit,
        options.hfSubset,
      );
    return { ...this.calculateScores(scores, normalizedScores) };
  }

  protected calculateScores(
    scores: STSEvaluatorScores,
    normalizedScores: readonly number[],
  ): STSMetrics {
    const computeCorr = (y: readonly number[]) =>
      [pearsonr(normalizedScores, y), spearmanr(normalizedScores, y)] as const;
    const [cosinePearson, cosineSpearman] = computeCorr(scores.cosineScores);
    const [manhattanPearson, manhattanSpearman] = computeCorr(
      scores.manhattanDistances,
    );
    const [euclideanPearson, euclideanSpearman] = computeCorr(
      scores.euclideanDistances,
    );
    const [pearson, spearman] = computeCorr(scores.similarityScores);
    return {
      pearson,
      spearman,
      cosine_pearson: cosinePearson,
      cosine_spearman: cosineSpearman,
      manhattan_pearson: manhattanPearson,
      manhattan_spearman: manhattanSpearman,
      euclidean_pearson: euclideanPearson,
      euclidean_spearman: euclideanSpearman,
    };
  }

  // A gold score scaled so that minScore is 0 and maxScore is 1.
  protected normalize(x: number): number {
    return (x - this.minScore) / (this.maxScore - this.minScore);
  }
}

// np.asarray of a gold score: a number, or a bool as 0 or 1.
function goldScore(value: DatasetValue | undefined): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  throw new TypeError(`A gold score must be a number, not ${String(value)}.`);
}
