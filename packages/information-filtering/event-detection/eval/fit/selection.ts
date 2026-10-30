import { type Interval, pairedBootstrap } from '../bootstrap.ts';
import type { Partition } from '../metrics/contingency.ts';
import { mainScore } from '../metrics/metrics.ts';

// The objective of a cross-validation: the mean over the families of the
// mean fold score of each family. A family with no fold in the scores is
// left out. families: the family of each fold, in the order of the rule.
export function objective(
  scores: ReadonlyMap<string, number>,
  families: ReadonlyMap<string, string>,
): number {
  const means = [...new Set(families.values())].flatMap((family) => {
    const values = [...scores]
      .filter(([fold]) => families.get(fold) === family)
      .map(([, value]) => value);
    return values.length === 0
      ? []
      : [values.reduce((sum, value) => sum + value, 0) / values.length];
  });
  return means.reduce((sum, value) => sum + value, 0) / means.length;
}

// The threshold with the best value. Equal values go to the higher threshold.
export function best(
  points: readonly { readonly threshold: number; readonly value: number }[],
): { readonly threshold: number; readonly value: number } {
  const [first, ...rest] = points;
  if (first === undefined) throw new Error('The grid has no threshold.');
  return rest.reduce(
    (chosen, point) =>
      point.value > chosen.value ||
      (point.value === chosen.value && point.threshold > chosen.threshold)
        ? point
        : chosen,
    first,
  );
}

// One fold separator that no report id or event label holds. The bootstrap
// adds its own suffix after the id.
const SEPARATOR = '\u0001';

// The paired block bootstrap of (challenger - incumbent) on the objective of
// a nested cross-validation (round 3152b, choice.simplerAllowed). The outer
// partitions of the folds are joined into one, each id and gold event
// prefixed by its fold, so no block crosses folds. A fold with no block in a
// replicate is left out of its family mean.
export function crossValidatedChange(options: {
  readonly folds: readonly {
    readonly name: string;
    readonly family: string;
    readonly gold: Partition;
  }[];
  readonly challenger: ReadonlyMap<string, Partition>;
  readonly incumbent: ReadonlyMap<string, Partition>;
}): Interval {
  const families = new Map(
    options.folds.map((fold) => [fold.name, fold.family]),
  );
  const joined = (of: (fold: string) => Partition) =>
    new Map(
      options.folds.flatMap((fold) =>
        [...of(fold.name)].map(
          ([id, event]) =>
            [
              `${fold.name}${SEPARATOR}${id}`,
              `${fold.name}${SEPARATOR}${event}`,
            ] as const,
        ),
      ),
    );
  const gold = joined(
    (name) => options.folds.find((fold) => fold.name === name)!.gold,
  );
  const challenger = joined((name) => options.challenger.get(name)!);
  const incumbent = joined((name) => options.incumbent.get(name)!);
  const ids = [...gold.keys()].filter(
    (id) => challenger.has(id) && incumbent.has(id),
  );
  const only = (partition: Partition) =>
    new Map(ids.map((id) => [id, partition.get(id)!]));
  return pairedBootstrap({
    gold: only(gold),
    run: only(challenger),
    latest: only(incumbent),
    statistic: (key, response) => {
      const byFold = Map.groupBy(key.keys(), (mention) =>
        mention.slice(0, mention.indexOf(SEPARATOR)),
      );
      return objective(
        new Map(
          [...byFold].map(([fold, mentions]) => [
            fold,
            mainScore(
              new Map(mentions.map((mention) => [mention, key.get(mention)!])),
              new Map(
                mentions.map((mention) => [mention, response.get(mention)!]),
              ),
            ),
          ]),
        ),
        families,
      );
    },
    replicates: 2000,
    seed: 3182,
  });
}
