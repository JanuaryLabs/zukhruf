import type { MTEBModels } from '../abstasks/abstask.ts';
import type { AbsTaskRetrieval } from '../abstasks/retrieval.ts';
import type { ResultCache } from '../cache/result-cache.ts';
import { DataFrame } from '../dependencies/pandas.ts';
import { pythonRound, pythonSum } from '../dependencies/python.ts';
import { perQueryScores } from '../significance/per-query-scores.ts';
import { page } from './page.ts';
import {
  type Comparison,
  type PrimaryComparison,
  type Verdict,
  verdicts,
} from './verdicts.ts';

// Not from MTEB. A report of the results of a retrieval task: the page of
// toHtml and the tables of scores and verdicts, from the result cache and the
// predictions that evaluate wrote. MTEB has its leaderboard, not a report.

// The scores of one model on one split and subset.
export type ModelScores = {
  readonly model: MTEBModels;
  // The model name, and the experiment when two models share a name.
  readonly label: string;
  // The numbers of the scores dict of the result.
  readonly scores: ReadonlyMap<string, number>;
  // The query score (SplitReport.queryScore) of each query that has a
  // relevant document.
  readonly perQuery: ReadonlyMap<string, number>;
  // The seconds that evaluate took on the task, over all its splits, as the
  // result records it; it counts loading the data of the task, which
  // evaluate does for each model unless the task was loaded before.
  readonly evaluationTime: number | null;
};

// What the report shows for one split and subset.
export type SplitReport = {
  readonly split: string;
  readonly subset: string;
  readonly models: readonly ModelScores[];
  readonly baseline: ModelScores;
  // The score of each query: the main score, or nDCG@10 when the main score
  // has no value for each query (MRR, for example).
  readonly queryScore: string;
  // The scores that the verdicts test.
  readonly tested: readonly string[];
  readonly verdicts: readonly Verdict[];
  // The queries that count: those with judgments, as in MTEB, also a query
  // whose grades are all 0, which scores 0 for each model. A query that is a
  // conversation has no text here.
  readonly queries: readonly { readonly id: string; readonly text: string }[];
  readonly allQueries: number;
  // The queries that count and have a relevant document (a grade above 0).
  readonly withRelevant: number;
  readonly documents: number;
  // The cut-offs of the task that the corpus is large enough for.
  readonly depths: readonly number[];
  // The recall of a perfect ranking at each depth: a query with more
  // relevant documents than results cannot find them all.
  readonly bestRecall: ReadonlyMap<number, number>;
  readonly relevantPerQuery: number;
};

export type ReportData = {
  readonly task: {
    readonly name: string;
    readonly description: string;
    readonly reference: string | null;
    readonly revision: string;
    readonly mainScore: string;
  };
  readonly primary: PrimaryComparison | undefined;
  readonly mtebVersion: string | null;
  readonly scoredAt: Date | null;
  readonly splits: readonly SplitReport[];
};

export type ReportOptions = {
  readonly task: AbsTaskRetrieval;
  // The models that evaluate scored on the task.
  readonly models: readonly MTEBModels[];
  readonly cache: ResultCache;
  // The folder that evaluate wrote the predictions of a model to.
  readonly predictionFolder: (model: MTEBModels) => string;
  // The model that each other model must beat; one of models.
  readonly baseline: MTEBModels;
  // The pairs to test, as [baseline, change]; each model against the
  // baseline by default.
  readonly comparisons?: readonly Comparison[];
  readonly primary?: PrimaryComparison;
  // The scores to test; the query score by default.
  readonly tested?: readonly [string, ...string[]];
};

// The scores of the table of each split besides the main score, when the
// results have them. A recall at a cut-off above the size of the corpus is 1
// for each model, so the table leaves it out.
const TABLE_SCORES = ['recall_at_10', 'recall_at_100', 'mrr_at_10'];
// The score of each query when the main score has none.
const FALLBACK_QUERY_SCORE = 'ndcg_at_10';

const cutOff = (score: string) =>
  Number(score.slice(score.lastIndexOf('_') + 1));

export class Report {
  // A row for each model and split: the main score, Recall@10, Recall@100
  // and MRR@10.
  readonly scores: DataFrame;
  // A row for each split, tested score and comparison.
  readonly verdicts: DataFrame;
  readonly #data: ReportData;

  constructor(init: {
    readonly data: ReportData;
    readonly scores: DataFrame;
    readonly verdicts: DataFrame;
  }) {
    this.#data = init.data;
    this.scores = init.scores;
    this.verdicts = init.verdicts;
  }

  static async from(options: ReportOptions): Promise<Report> {
    const { task, models, baseline } = options;
    const { metadata } = task;
    // The name of a model, with its experiment when two models share it.
    const label = (model: MTEBModels) => {
      const { name, experimentName } = model.mtebModelMeta;
      const shared =
        models.filter((other) => other.mtebModelMeta.name === name).length > 1;
      return shared && experimentName !== null
        ? `${String(name)} (${experimentName})`
        : String(name);
    };
    if (!models.includes(baseline))
      throw new RangeError(
        `The baseline ${label(baseline)} is not one of models.`,
      );
    const comparisons =
      options.comparisons ??
      models
        .filter((model) => model !== baseline)
        .map((model) => [baseline, model] as const);
    await task.loadData();
    const results = options.cache
      .loadResults({
        includeRemote: false,
        models: models.map((model) => model.mtebModelMeta),
      })
      .selectTasks([task]);
    const taskResults = models.map((model) => {
      const meta = model.mtebModelMeta;
      const result = results.modelResults
        .find(
          (candidate) =>
            candidate.modelName === meta.name &&
            candidate.experimentName === meta.experimentName,
        )
        ?.taskResults.find(({ taskName }) => taskName === metadata.name);
      if (result === undefined)
        throw new Error(
          `${label(model)} has no result of ${metadata.name} in the cache. Run evaluate with this cache first.`,
        );
      return { model, result };
    });

    const splits: SplitReport[] = [];
    for (const split of metadata.evalSplits)
      for (const subset of metadata.hfSubsets) {
        const data = task.dataset?.get(subset)?.get(split);
        if (data === undefined)
          throw new Error(
            `${metadata.name} has no split ${split} in subset ${subset}.`,
          );
        const scored = await Promise.all(
          taskResults.map(async ({ model, result }) => {
            const dict = result.scores[split]?.find(
              (scores) => (scores['hf_subset'] ?? 'default') === subset,
            );
            if (dict === undefined)
              throw new Error(
                `${label(model)} has no ${split} scores of ${metadata.name} in subset ${subset}. Run evaluate on that split.`,
              );
            const { score, values } = await queryScores(
              task,
              options.predictionFolder(model),
              split,
              subset,
              label(model),
            );
            const scores = new Map(
              Object.entries(dict).flatMap(([key, value]) =>
                typeof value === 'number' ? [[key, value] as const] : [],
              ),
            );
            // The result is the mean of the scores of the queries, rounded to
            // 5 digits, as the evaluation calculates it. Predictions of
            // another run give another mean: the page would then draw the
            // queries and the verdicts of one run and the scores of another.
            const averaged = pythonRound(
              pythonSum(values.values()) / values.size,
              5,
            );
            if (!Object.is(averaged, scores.get(score)))
              throw new Error(
                `The predictions of ${label(model)} in ${options.predictionFolder(model)} do not match its result on ${split} (subset ${subset}): the ${score} of their queries averages ${averaged}, and the result has ${scores.has(score) ? String(scores.get(score)) : `no ${score}`}. They come from another run, or the qrels changed after the run. Run evaluate again with predictionFolder set to this folder and overwriteStrategy 'always'.`,
              );
            const entry: ModelScores = {
              model,
              label: label(model),
              scores,
              perQuery: values,
              evaluationTime: result.evaluationTime,
            };
            return { queryScore: score, entry };
          }),
        );
        const baselineScored = scored.find(
          ({ entry }) => entry.model === baseline,
        );
        if (baselineScored === undefined) continue;
        const { queryScore, entry: baselineScores } = baselineScored;
        const tested = options.tested ?? [queryScore];
        const relevant = [...data.relevantDocs]
          .filter(([id]) => baselineScores.perQuery.has(id))
          .map(
            ([, documents]) =>
              [...documents.values()].filter((grade) => grade > 0).length,
          );
        const depths = task.kValues.filter((k) => k <= data.corpus.length);
        splits.push({
          split,
          subset,
          models: scored.map(({ entry }) => entry),
          baseline: baselineScores,
          queryScore,
          tested,
          verdicts: await verdicts({
            task,
            split,
            subset,
            comparisons,
            scores: tested,
            ...(options.primary === undefined
              ? {}
              : { primary: options.primary }),
            predictionFolder: options.predictionFolder,
          }),
          queries: data.queries
            .filter(({ id }) => baselineScores.perQuery.has(id))
            .map(({ id, text }) => ({
              id,
              text: typeof text === 'string' ? text : '',
            })),
          allQueries: data.queries.length,
          withRelevant: relevant.filter((count) => count > 0).length,
          documents: data.corpus.length,
          depths,
          // A query without a relevant document has a recall of 0, in
          // trec_eval as here.
          bestRecall: new Map(
            depths.map((k) => [
              k,
              mean(
                relevant.map((count) =>
                  count === 0 ? 0 : Math.min(k, count) / count,
                ),
              ),
            ]),
          ),
          relevantPerQuery: mean(relevant),
        });
      }

    const dates = taskResults.flatMap(({ result }) =>
      result.date === null ? [] : [result.date],
    );
    const versions = taskResults.flatMap(({ result }) =>
      result.mtebVersion === null ? [] : [result.mtebVersion],
    );
    const multipleSubsets = metadata.hfSubsets.length > 1;
    const sharedNames =
      new Set(models.map((model) => model.mtebModelMeta.name)).size <
      models.length;
    const documents = Math.min(...splits.map((split) => split.documents));
    const tableScores: [string, ...string[]] = [
      metadata.mainScore,
      ...TABLE_SCORES.filter(
        (score) =>
          score !== metadata.mainScore &&
          !(score.startsWith('recall_at_') && cutOff(score) > documents) &&
          splits.every((split) => split.baseline.scores.has(score)),
      ),
    ];
    return new Report({
      data: {
        task: {
          name: metadata.name,
          description: metadata.description,
          reference: metadata.reference,
          revision: metadata.revision,
          mainScore: metadata.mainScore,
        },
        primary: options.primary,
        mtebVersion: versions.at(0) ?? null,
        scoredAt:
          dates.length === 0 ? null : new Date(Math.max(...dates.map(Number))),
        splits,
      },
      scores: results.toDataFrame({
        aggregationLevel: multipleSubsets ? 'subset' : 'split',
        format: 'long',
        includeExperiments: sharedNames,
        scores: tableScores,
      }),
      verdicts: new DataFrame(
        [
          'split',
          ...(multipleSubsets ? ['subset'] : []),
          'score',
          'baseline',
          'change',
          'primary',
          'difference',
          'low',
          'high',
          'p',
          'deciding_p',
          'result',
        ],
        splits.flatMap(({ split, subset, verdicts: list }) =>
          list.map((verdict) => [
            split,
            ...(multipleSubsets ? [subset] : []),
            verdict.score,
            label(verdict.baseline),
            label(verdict.change),
            verdict.primary,
            verdict.observed,
            verdict.low,
            verdict.high,
            verdict.p,
            verdict.decidingP,
            verdict.result,
          ]),
        ),
      ),
    });
  }

  // The report as one HTML page: a switch over the splits, then for each
  // split a claim above each chart, with its numbers as a table.
  toHtml(): string {
    return page(this.#data);
  }

  // The tables of scores and verdicts as Markdown.
  toMarkdown(): string {
    return `## Scores\n\n${this.scores.toMarkdown()}\n\n## Verdicts\n\n${this.verdicts.toMarkdown()}\n`;
  }
}

// The score of each query, from the predictions: the main score, or nDCG@10
// when perQueryScores has no value of the main score for each query. A
// missing predictions file means that evaluate did not write it: a result
// read from the cache writes no predictions.
async function queryScores(
  task: AbsTaskRetrieval,
  folder: string,
  split: string,
  subset: string,
  label: string,
): Promise<{ score: string; values: ReadonlyMap<string, number> }> {
  const read = async (score: string) => {
    try {
      return {
        score,
        values: await perQueryScores(task, folder, { split, subset, score }),
      };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        throw new Error(
          `${label} has no predictions in ${folder}. Run evaluate with predictionFolder set to this folder and overwriteStrategy 'always': a result read from the cache writes no predictions.`,
          { cause: error },
        );
      throw error;
    }
  };
  try {
    return await read(task.metadata.mainScore);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return read(FALLBACK_QUERY_SCORE);
  }
}

const mean = (values: readonly number[]) =>
  values.length === 0
    ? Number.NaN
    : values.reduce((sum, value) => sum + value, 0) / values.length;
