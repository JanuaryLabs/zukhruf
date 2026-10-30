import {
  addReduceat,
  argsortStable,
  linspace,
  mean,
  std,
} from '../dependencies/numpy.ts';
import {
  pythonRound,
  pythonRoundToInteger,
  pythonSum,
  rankByScore,
} from '../dependencies/python.ts';
import { RelevanceEvaluator } from '../dependencies/pytrec-eval.ts';
import { auc } from '../dependencies/sklearn.ts';
import type { RelevantDocumentsType } from '../types/encoder-io.ts';
import type { RetrievalEvaluationResult, Score } from '../types/result.ts';

// The scores of one query for each document.
type Run = ReadonlyMap<string, ReadonlyMap<string, number>>;

// For each metric name ("MRR@10"), the value of each query.
type PerQuery = Record<string, number[]>;

// The abstention rates of the nAUC: 0.0, 0.1, ..., 0.9.
const DEFAULT_ABSTENTION_RATES = linspace(0, 1, 11).slice(0, -1);

// A Python dict lookup: a missing key raises.
function item<Value>(map: ReadonlyMap<string, Value>, key: string): Value {
  const value = map.get(key);
  if (value === undefined) throw new Error(`KeyError: '${key}'`);
  return value;
}

function relevantOf(qrels: RelevantDocumentsType, query: string): Set<string> {
  const judged = item(qrels, query);
  return new Set(
    [...judged].filter(([, relevance]) => relevance > 0).map(([id]) => id),
  );
}

function mrr(
  qrels: RelevantDocumentsType,
  results: Run,
  kValues: readonly number[],
): PerQuery {
  const metrics: PerQuery = {};
  const kMax = Math.max(...kValues);
  for (const [query, scores] of results) {
    const topHits = rankByScore(scores).slice(0, kMax);
    const relevant = relevantOf(qrels, query);
    for (const k of kValues) {
      const rank = topHits.slice(0, k).findIndex(([id]) => relevant.has(id));
      (metrics[`MRR@${k}`] ??= []).push(rank === -1 ? 0 : 1 / (rank + 1));
    }
  }
  return metrics;
}

// The maximum, the standard deviation and the margin between the two best of
// the similarity scores of one query, as measures of confidence.
export function confidenceScores(similarityScores: readonly number[]): {
  max: number;
  std: number;
  diff1: number;
} {
  if (similarityScores.length === 0) return { max: 0, std: 0, diff1: 0 };
  const sorted = [...similarityScores].sort((left, right) => right - left);
  const [first = 0, second] = sorted;
  return {
    max: first,
    std: std(similarityScores),
    diff1: second === undefined ? 0 : first - second,
  };
}

// The normalized area under the abstention curve (https://arxiv.org/abs/2402.12997):
// how much the confidence of a query predicts its metric, between a flat curve
// (0) and the oracle (1).
export function nauc(
  confidence: readonly number[],
  metrics: readonly number[],
  abstentionRates: readonly number[] = DEFAULT_ABSTENTION_RATES,
): number {
  const curve = abstentionCurve(confidence, metrics, abstentionRates);
  const oracle = abstentionCurve(metrics, metrics, abstentionRates);
  const area = auc(abstentionRates, curve);
  const oracleArea = auc(abstentionRates, oracle);
  const flatArea =
    (oracle[0] ?? 0) *
    ((abstentionRates.at(-1) ?? 0) - (abstentionRates[0] ?? 0));
  return oracleArea === flatArea
    ? Number.NaN
    : (area - flatArea) / (oracleArea - flatArea);
}

// The mean metric of the queries kept at each abstention rate. A cutoff
// inside a group of equal confidences keeps the mean of the group, so the
// order of the input does not matter (#5613).
function abstentionCurve(
  confidence: readonly number[],
  metrics: readonly number[],
  abstentionRates: readonly number[],
): number[] {
  const order = argsortStable(confidence);
  if (confidence.length === 0) return abstentionRates.map(() => Number.NaN);
  if (order.some((index) => index >= metrics.length))
    throw new Error('IndexError: index is out of bounds');
  const sortedConfidence = order.map((index) => confidence[index] ?? 0);
  const sortedMetrics = order.map((index) => metrics[index] ?? 0);
  const groupStarts = sortedConfidence.flatMap((value, index) =>
    index === 0 || value !== sortedConfidence[index - 1] ? [index] : [],
  );
  const groupSizes = groupStarts.map(
    (start, index) =>
      (groupStarts[index + 1] ?? sortedConfidence.length) - start,
  );
  const groupMeans = addReduceat(sortedMetrics, groupStarts).map(
    (total, index) => total / (groupSizes[index] ?? 1),
  );
  const smoothed = groupMeans.flatMap((value, index) =>
    Array.from({ length: groupSizes[index] ?? 0 }, () => value),
  );
  return abstentionRates.map((rate) => {
    const abstained = Math.min(
      pythonRoundToInteger(rate * order.length),
      confidence.length - 1,
    );
    return mean(smoothed.slice(abstained));
  });
}

// The scores dict of a retrieval task, with MTEB's key names.
export function makeScoreDict(options: {
  readonly ndcg: Readonly<Record<string, number>>;
  readonly map: Readonly<Record<string, number>>;
  readonly recall: Readonly<Record<string, number>>;
  readonly precision: Readonly<Record<string, number>>;
  readonly mrr: Readonly<Record<string, number>>;
  readonly naucs: Readonly<Record<string, number>>;
  readonly naucsMrr: Readonly<Record<string, number>>;
  readonly hitRate: Readonly<Record<string, number>>;
  readonly taskScores: Readonly<Record<string, Score>>;
  readonly previousResultsModelMeta?: Readonly<Record<string, Score>> | null;
}): Record<string, Score> {
  const at = (key: string): string => key.split('@')[1] ?? '';
  const nAuc = (key: string): string =>
    key.replaceAll('@', '_at_').replaceAll('_P', '_precision').toLowerCase();
  const accuracy = options.recall['Recall@1'];
  if (accuracy === undefined) throw new Error("KeyError: 'Recall@1'");
  const previous = options.previousResultsModelMeta;
  return {
    ...rename(options.ndcg, (key) => `ndcg_at_${at(key)}`),
    ...rename(options.map, (key) => `map_at_${at(key)}`),
    ...rename(options.recall, (key) => `recall_at_${at(key)}`),
    // For multichoice tasks MTEB reports recall@1 as the main metric; it
    // equals accuracy there.
    accuracy,
    ...rename(options.precision, (key) => `precision_at_${at(key)}`),
    ...rename(options.mrr, (key) => `mrr_at_${at(key)}`),
    ...rename(options.naucs, nAuc),
    ...rename(options.naucsMrr, nAuc),
    ...rename(options.hitRate, (key) => `hit_rate_at_${at(key)}`),
    ...options.taskScores,
    ...(previous && Object.keys(previous).length > 0
      ? { previous_results_model_meta: previous }
      : {}),
  };
}

function rename(
  values: Readonly<Record<string, number>>,
  name: (key: string) => string,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [name(key), value]),
  );
}

// The mean of each trec_eval measure over the queries, rounded to 5 digits,
// and the value of each query.
function parseMetricsFromScores(
  scores: ReadonlyMap<string, Readonly<Record<string, number>>>,
  kValues: readonly number[],
): {
  ndcg: Record<string, number>;
  map: Record<string, number>;
  recall: Record<string, number>;
  precision: Record<string, number>;
  allNdcgs: PerQuery;
  allAps: PerQuery;
  allRecalls: PerQuery;
  allPrecisions: PerQuery;
  hitRate: Record<string, number>;
} {
  const allNdcgs: PerQuery = {};
  const allAps: PerQuery = {};
  const allRecalls: PerQuery = {};
  const allPrecisions: PerQuery = {};
  const allHitRates: PerQuery = {};
  for (const values of scores.values())
    for (const k of kValues) {
      (allNdcgs[`NDCG@${k}`] ??= []).push(measureOf(values, `ndcg_cut_${k}`));
      (allAps[`MAP@${k}`] ??= []).push(measureOf(values, `map_cut_${k}`));
      (allRecalls[`Recall@${k}`] ??= []).push(measureOf(values, `recall_${k}`));
      (allPrecisions[`P@${k}`] ??= []).push(measureOf(values, `P_${k}`));
      (allHitRates[`HitRate@${k}`] ??= []).push(
        measureOf(values, `success_${k}`),
      );
    }
  if (scores.size === 0) throw new Error('ZeroDivisionError: division by zero');
  const average = (values: readonly number[] | undefined): number =>
    pythonRound(pythonSum(values ?? []) / scores.size, 5);
  const ndcg: Record<string, number> = {};
  const map: Record<string, number> = {};
  const recall: Record<string, number> = {};
  const precision: Record<string, number> = {};
  const hitRate: Record<string, number> = {};
  for (const k of kValues) {
    ndcg[`NDCG@${k}`] = average(allNdcgs[`NDCG@${k}`]);
    map[`MAP@${k}`] = average(allAps[`MAP@${k}`]);
    recall[`Recall@${k}`] = average(allRecalls[`Recall@${k}`]);
    precision[`P@${k}`] = average(allPrecisions[`P@${k}`]);
    hitRate[`HitRate@${k}`] = average(allHitRates[`HitRate@${k}`]);
  }
  return {
    ndcg,
    map,
    recall,
    precision,
    allNdcgs,
    allAps,
    allRecalls,
    allPrecisions,
    hitRate,
  };
}

function measureOf(
  values: Readonly<Record<string, number>>,
  key: string,
): number {
  const value = values[key];
  if (value === undefined) throw new Error(`KeyError: '${key}'`);
  return value;
}

export function calculateRetrievalScores(
  results: Run,
  qrels: RelevantDocumentsType,
  kValues: readonly number[],
  skipFirstResult = false,
): RetrievalEvaluationResult {
  const run: Run = skipFirstResult
    ? new Map(
        [...results].map(([query, scores]) => [
          query,
          new Map(
            [...scores]
              .map((entry, index) => ({ entry, index }))
              .sort(
                (left, right) =>
                  right.entry[1] - left.entry[1] || left.index - right.index,
              )
              .slice(1)
              .map(({ entry }) => entry),
          ),
        ]),
      )
    : results;
  const cutoffs = kValues.join(',');
  const evaluator = new RelevanceEvaluator(qrels, [
    `map_cut.${cutoffs}`,
    `ndcg_cut.${cutoffs}`,
    `recall.${cutoffs}`,
    `P.${cutoffs}`,
    `success.${cutoffs}`,
  ]);
  const scores = evaluator.evaluate(run);
  const parsed = parseMetricsFromScores(scores, kValues);
  const mrrScores = mrr(qrels, run, kValues);
  const naucs = evaluateAbstention(run, {
    ...parsed.allNdcgs,
    ...parsed.allAps,
    ...parsed.allRecalls,
    ...parsed.allPrecisions,
  });
  const naucsMrr = evaluateAbstention(run, mrrScores);
  const averageMrr = Object.fromEntries(
    Object.entries(mrrScores).map(([key, values]) => [
      key,
      pythonSum(values) / values.length,
    ]),
  );
  return {
    allScores: scores,
    ndcg: parsed.ndcg,
    map: parsed.map,
    recall: parsed.recall,
    precision: parsed.precision,
    naucs,
    mrr: averageMrr,
    naucsMrr,
    hitRate: parsed.hitRate,
  };
}

// The nAUC of each metric for each confidence measure.
function evaluateAbstention(
  results: Run,
  metricScores: Readonly<PerQuery>,
): Record<string, number> {
  const confidences = [...results.values()].map((scores) =>
    confidenceScores([...scores.values()]),
  );
  if (confidences.length === 0)
    throw new Error('IndexError: list index out of range');
  const naucs: Record<string, number> = {};
  for (const [metric, values] of Object.entries(metricScores))
    for (const measure of ['max', 'std', 'diff1'] as const)
      naucs[`nAUC_${metric}_${measure}`] = nauc(
        confidences.map((confidence) => confidence[measure]),
        values,
      );
  return naucs;
}
