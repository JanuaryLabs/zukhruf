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
