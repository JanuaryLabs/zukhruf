// The scores of a predicted partition against the answer key. Both maps give
// each report id its group: the gold event, or the event of the detector.
// F0.5 counts precision two times as much as recall, because a false join
// hides a report from the reader and a false split only shows a duplicate
// (ADR 0003).

export type PairScore = {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  // Null when the partition joins no pair (precision) or the answer key has
  // no pair (recall).
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f05: number;
};

export type BCubedScore = {
  readonly precision: number;
  readonly recall: number;
  readonly f05: number;
};

// Pair scores over each unordered pair of ids that keep accepts. A pair is
// positive when both ids have one group.
export function pairScore(
  gold: ReadonlyMap<string, string>,
  predicted: ReadonlyMap<string, string>,
  keep: (a: string, b: string) => boolean = () => true,
): PairScore {
  const ids = [...gold.keys()];
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const [index, a] of ids.entries())
    for (const b of ids.slice(index + 1)) {
      if (!keep(a, b)) continue;
      const same = gold.get(a) === gold.get(b);
      const joined = predicted.get(a) === predicted.get(b);
      if (same && joined) truePositives++;
      else if (joined) falsePositives++;
      else if (same) falseNegatives++;
    }
  const predictedPairs = truePositives + falsePositives;
  const goldPairs = truePositives + falseNegatives;
  const weighted =
    1.25 * truePositives + falsePositives + 0.25 * falseNegatives;
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision: predictedPairs === 0 ? null : truePositives / predictedPairs,
    recall: goldPairs === 0 ? null : truePositives / goldPairs,
    f05: weighted === 0 ? 0 : (1.25 * truePositives) / weighted,
  };
}

// B-cubed (Bagga and Baldwin 1998): for each report, the share of its
// predicted group that is in its gold event (precision), and the share of its
// gold event that is in its predicted group (recall), averaged over the
// reports.
export function bcubedScore(
  gold: ReadonlyMap<string, string>,
  predicted: ReadonlyMap<string, string>,
): BCubedScore {
  const overlap = countBy(gold.keys(), (id) =>
    JSON.stringify([predicted.get(id), gold.get(id)]),
  );
  const goldSize = countBy(gold.keys(), (id) => gold.get(id));
  const predictedSize = countBy(gold.keys(), (id) => predicted.get(id));
  let precision = 0;
  let recall = 0;
  for (const id of gold.keys()) {
    const shared =
      overlap.get(JSON.stringify([predicted.get(id), gold.get(id)])) ?? 0;
    precision += shared / (predictedSize.get(predicted.get(id)) ?? 1);
    recall += shared / (goldSize.get(gold.get(id)) ?? 1);
  }
  precision /= gold.size;
  recall /= gold.size;
  return {
    precision,
    recall,
    f05: (1.25 * precision * recall) / (0.25 * precision + recall),
  };
}

function countBy<T>(
  items: Iterable<string>,
  key: (item: string) => T,
): Map<T, number> {
  const counts = new Map<T, number>();
  for (const item of items) {
    const value = key(item);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}
