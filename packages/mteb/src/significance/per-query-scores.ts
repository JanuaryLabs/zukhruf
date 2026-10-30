import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type AbsTaskRetrieval,
  predictionsFile,
} from '../abstasks/retrieval.ts';
import { calculateRetrievalScores } from '../evaluators/retrieval-metrics.ts';

// Not from MTEB: MTEB keeps the score of each query only inside its
// evaluation.

// The trec_eval measure of each score name that has a value for each query
// (ndcg_at_10 is ndcg_cut_10).
const MEASURES: readonly (readonly [prefix: string, measure: string])[] = [
  ['ndcg_at_', 'ndcg_cut_'],
  ['map_at_', 'map_cut_'],
  ['recall_at_', 'recall_'],
  ['precision_at_', 'P_'],
  ['hit_rate_at_', 'success_'],
];

function trecMeasure(score: string): string {
  for (const [prefix, measure] of MEASURES)
    if (score.startsWith(prefix))
      return `${measure}${score.slice(prefix.length)}`;
  throw new RangeError(
    `${score} has no value for each query. Use a score of ${MEASURES.map(([prefix]) => `${prefix}<k>`).join(', ')}.`,
  );
}

// The value of a score for each query, from the predictions that evaluate
// saved to predictionFolder. The values are those of the evaluation of the
// task: the predictions hold only the queries that the evaluation scored,
// and perQueryScores applies ignoreIdenticalIds and skipFirstResult. The score is the main score of the
// task by default. The mean of the values, rounded to 5 digits, is the score
// in the result.
export async function perQueryScores(
  task: AbsTaskRetrieval,
  predictionFolder: string,
  options: {
    readonly split?: string;
    readonly subset?: string;
    readonly score?: string;
  } = {},
): Promise<Map<string, number>> {
  const split = options.split ?? task.evalSplits[0] ?? 'test';
  const subset = options.subset ?? 'default';
  const measure = trecMeasure(options.score ?? task.metadata.mainScore);
  await task.loadData();
  const data = task.dataset?.get(subset)?.get(split);
  if (data === undefined)
    throw new Error(
      `${task.metadata.name} has no split ${split} in subset ${subset}.`,
    );
  const predictions = predictionsFile.parse(
    JSON.parse(
      readFileSync(join(predictionFolder, task.predictionFileName), 'utf8'),
    ),
  ).subsets[subset]?.[split];
  if (predictions === undefined)
    throw new Error(
      `The predictions of ${task.metadata.name} in ${predictionFolder} have no split ${split} in subset ${subset}.`,
    );
  const run = new Map(
    Object.entries(predictions).map(([query, scores]) => [
      query,
      new Map(
        Object.entries(scores).filter(
          ([document]) => !(task.ignoreIdenticalIds && document === query),
        ),
      ),
    ]),
  );
  const { allScores } = calculateRetrievalScores(
    run,
    data.relevantDocs,
    task.kValues,
    task.skipFirstResult,
  );
  return new Map(
    [...allScores].map(([query, values]) => {
      const value = values[measure];
      if (value === undefined) throw new Error(`KeyError: '${measure}'`);
      return [query, value];
    }),
  );
}
