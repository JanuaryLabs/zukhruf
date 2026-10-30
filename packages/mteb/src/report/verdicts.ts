import type { MTEBModels } from '../abstasks/abstask.ts';
import type { AbsTaskRetrieval } from '../abstasks/retrieval.ts';
import { holm } from '../significance/holm.ts';
import {
  type ChangeVerdict,
  pairedBootstrapTest,
} from '../significance/paired-bootstrap.ts';
import { perQueryScores } from '../significance/per-query-scores.ts';

// Not from MTEB. Says, for each pair of models and each tested score, if the
// difference on a split is more than chance: a paired bootstrap test over the
// queries (pairedBootstrapTest), on the predictions that evaluate wrote.

// The level below which a deciding p-value counts.
const ALPHA = 0.05;

// The result of a test from the p-value that decides it: a difference counts
// when p is below 0.05, and its sign says better or worse.
export const decide = (p: number, observed: number): ChangeVerdict['result'] =>
  p >= ALPHA ? 'inconclusive' : observed > 0 ? 'better' : 'worse';

// A pair of models: the change against its baseline.
export type Comparison = readonly [baseline: MTEBModels, change: MTEBModels];

// The comparison that was declared before the scores were seen, on one
// score. It is tested alone at 0.05; Holm-Bonferroni adjusts the p-values of
// the other comparisons as one family, so the chance of one false "better"
// or "worse" among them stays at 0.05.
export type PrimaryComparison = {
  readonly baseline: MTEBModels;
  readonly change: MTEBModels;
  readonly score: string;
};

export type Verdict = Omit<ChangeVerdict, 'result'> & {
  readonly baseline: MTEBModels;
  readonly change: MTEBModels;
  readonly score: string;
  readonly primary: boolean;
  // The p-value that decides the result: p for the primary comparison, the
  // Holm-adjusted p for the others.
  readonly decidingP: number;
  readonly result: ChangeVerdict['result'];
};

// The verdict of each comparison on each score, in the order of scores, then
// of comparisons. predictionFolder gives the folder that evaluate wrote the
// predictions of a model to.
export async function verdicts(options: {
  readonly task: AbsTaskRetrieval;
  readonly split: string;
  readonly subset?: string;
  readonly comparisons: readonly Comparison[];
  readonly scores: readonly string[];
  readonly primary?: PrimaryComparison;
  readonly predictionFolder: (model: MTEBModels) => string;
}): Promise<Verdict[]> {
  const { task, split, subset = 'default', primary } = options;
  const perQuery = (model: MTEBModels, score: string) =>
    perQueryScores(task, options.predictionFolder(model), {
      split,
      subset,
      score,
    });
  const tested = [];
  for (const score of options.scores)
    for (const [baseline, change] of options.comparisons)
      tested.push({
        baseline,
        change,
        score,
        primary:
          primary !== undefined &&
          baseline === primary.baseline &&
          change === primary.change &&
          score === primary.score,
        verdict: pairedBootstrapTest(
          await perQuery(baseline, score),
          await perQuery(change, score),
        ),
      });
  const family = tested.filter((test) => !test.primary);
  const adjusted = new Map(
    holm(family.map(({ verdict }) => verdict.p)).map((p, index) => [
      family[index],
      p,
    ]),
  );
  return tested.map((test) => {
    const decidingP = adjusted.get(test) ?? test.verdict.p;
    return {
      ...test.verdict,
      baseline: test.baseline,
      change: test.change,
      score: test.score,
      primary: test.primary,
      decidingP,
      result: decide(decidingP, test.verdict.observed),
    };
  });
}
