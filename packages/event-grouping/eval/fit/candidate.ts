import type { Design } from '../../src/index.ts';
import type { Partition } from '../metrics/contingency.ts';
import { mainScore } from '../metrics/metrics.ts';
import { partitions, score } from '../score.ts';
import { CrossValidation } from './cross-validation.ts';
import { TRAINING } from './irls.ts';
import type { Candidate } from './rule.ts';
import { best } from './selection.ts';
import type { Stream } from './stream.ts';

const METRICS = ['muc', 'bCubed', 'ceafE', 'blanc', 'pair'] as const;

export type Evaluation = {
  readonly candidate: Candidate;
  // The design with the weights of all folds and the threshold of the flat
  // curve. A fitted design has no plan yet: plan.json is its record.
  readonly design: Design;
  // The nested-CV objective, and the events of each outer fold.
  readonly objective: number;
  readonly outer: ReadonlyMap<string, Partition>;
  readonly families: Readonly<
    Record<
      string,
      {
        readonly conll: { readonly f05: number };
        readonly baselines: {
          readonly allSingletons: number;
          readonly allInOne: number;
        };
      }
    >
  >;
  // What plan.json records of the candidate.
  readonly record: Record<string, unknown>;
};

// The nested and the flat cross-validation of one candidate on the folds of
// its streams, its family table and its final design.
export async function evaluate(
  candidate: Candidate,
  streams: readonly Stream[],
): Promise<Evaluation> {
  const cv = new CrossValidation(streams, candidate);
  const flat = await cv.flat();
  const final = best(flat);
  const outer = await cv.nested();
  const foldOf = (name: string) =>
    streams.find((stream) => stream.fold.name === name)!.fold;
  const objective = cv.objective(
    new Map(
      outer.map((fold) => {
        const { gold, predicted } = partitions(
          foldOf(fold.fold).rows,
          fold.eventOf,
        );
        return [fold.fold, mainScore(gold, predicted)];
      }),
    ),
  );
  const model = cv.model([]);
  const design = cv.design(model, final.threshold);

  // The mean of each score over the outer folds of each family.
  const scored = outer.map((fold) => {
    const { rows, texts } = foldOf(fold.fold);
    return { ...fold, score: score(rows, texts, fold.eventOf, []) };
  });
  const families = Object.fromEntries(
    [...new Set(outer.map((fold) => fold.family))].map((family) => {
      const folds = scored.filter((fold) => fold.family === family);
      const mean = (value: (fold: (typeof folds)[number]) => number) =>
        folds.reduce((sum, fold) => sum + value(fold), 0) / folds.length;
      return [
        family,
        {
          ...Object.fromEntries(
            METRICS.map((name) => [
              name,
              Object.fromEntries(
                (['precision', 'recall', 'f1', 'f05'] as const).map((key) => [
                  key,
                  mean((fold) => fold.score[name][key]),
                ]),
              ),
            ]),
          ),
          conll: {
            f1: mean((fold) => fold.score.conll.f1),
            f05: mean((fold) => fold.score.conll.f05),
          },
          baselines: {
            allSingletons: mean(
              (fold) => fold.score.baselines.allSingletons.conll.f05,
            ),
            allInOne: mean((fold) => fold.score.baselines.allInOne.conll.f05),
          },
          thresholds: folds.map((fold) => fold.threshold),
        },
      ];
    }),
  );

  const { planSha256: _, ...fitted } = design;
  return {
    candidate,
    design,
    objective,
    outer: new Map(outer.map((fold) => [fold.fold, fold.eventOf])),
    families,
    record: {
      design: fitted,
      training: {
        ...TRAINING,
        rows: model.rows,
        positives: model.positives,
        iterations: model.iterations,
        pairs: `batch shortlist pairs (top ${candidate.recipe.shortlistSize} within ${candidate.recipe.windowDays} days) of all ${streams.length} training folds`,
      },
      crossValidation: {
        objective,
        families,
        outer: outer.map(({ fold, family, threshold, innerObjective }) => ({
          fold,
          family,
          threshold,
          innerObjective,
        })),
        flat: { curve: flat, final },
      },
    },
  };
}
