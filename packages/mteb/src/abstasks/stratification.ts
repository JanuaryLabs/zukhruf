import { RandomState } from '../dependencies/numpy-random.ts';
import type { LabelIndicator } from '../dependencies/sklearn.ts';

// mteb/abstasks/_stratification.py, a copy of scikit-multilearn's iterative
// stratification (Sechidis et al. 2011, Szymański and Kajdanowicz 2017), as
// _iterative_train_test_split calls it: 2 folds, label pairs (order 2), and a
// RandomState of the seed that breaks the ties between folds.

// _iterative_train_test_split(X, y, test_size, random_state): the indices of
// the train and the test rows, in increasing order. y is a label indicator
// matrix; X only gives the number of rows, which y also gives.
export function iterativeTrainTestSplit(
  y: LabelIndicator,
  testSize: number,
  randomState: number,
): { readonly train: number[]; readonly test: number[] } {
  const stratifier = new IterativeStratification({
    nSplits: 2,
    order: 2,
    sampleDistributionPerFold: [testSize, 1 - testSize],
    randomState,
  });
  // _BaseKFold.split: the first fold is the test fold, and a mask gives the
  // indices of each side in increasing order.
  const [testFold = []] = stratifier.folds(y);
  const inTest = new Set(testFold);
  const all = y.map((_, index) => index);
  return {
    train: all.filter((index) => !inTest.has(index)),
    test: all.filter((index) => inTest.has(index)),
  };
}

// A label combination of the order of the stratifier, as a key of a Map:
// Python keys its dicts with the tuple.
type Combination = string;

export class IterativeStratification {
  readonly nSplits: number;
  readonly order: number;
  readonly percentagePerFold: readonly number[];
  readonly #rng: RandomState;

  constructor(options: {
    readonly nSplits: number;
    readonly order: number;
    readonly sampleDistributionPerFold: readonly number[];
    readonly randomState: number;
  }) {
    if (!Number.isInteger(options.nSplits) || options.nSplits < 2)
      throw new Error(
        `k-fold cross-validation requires at least one train/test split by setting n_splits=2 or more, got n_splits=${options.nSplits}.`,
      );
    this.nSplits = options.nSplits;
    this.order = options.order;
    this.percentagePerFold = options.sampleDistributionPerFold;
    this.#rng = new RandomState(options.randomState);
  }

  // The rows of each fold, in the order the stratifier puts them there
  // (_iter_test_indices).
  folds(y: LabelIndicator): number[][] {
    const nSamples = y.length;
    if (this.nSplits > nSamples)
      throw new Error(
        `Cannot have number of splits n_splits=${this.nSplits} greater than the number of samples: n_samples=${nSamples}.`,
      );
    // _prepare_stratification.
    const desiredSamplesPerFold = this.percentagePerFold.map(
      (percentage) => percentage * nSamples,
    );
    const rowsUsed = new Array<boolean>(nSamples).fill(false);
    const perRowCombinations: Combination[][] = [];
    const samplesWithCombination = new Map<Combination, number[]>();
    const combinationSize = new Map<Combination, number>();
    for (const [sampleIndex, row] of y.entries()) {
      // sp.lil_matrix(y).rows: the columns of the nonzero values.
      const labels = row.flatMap((value, column) =>
        value === 0 ? [] : [column],
      );
      const combinations: Combination[] = [];
      for (const combination of combinationsWithReplacement(
        labels,
        this.order,
      )) {
        const key = combination.join(',');
        const evidence = samplesWithCombination.get(key) ?? [];
        evidence.push(sampleIndex);
        samplesWithCombination.set(key, evidence);
        combinationSize.set(key, new Set(combination).size);
        combinations.push(key);
      }
      perRowCombinations.push(combinations);
    }
    const desiredPerCombination = new Map(
      [...samplesWithCombination].map(([key, evidence]) => [
        key,
        this.percentagePerFold.map(
          (percentage) => evidence.length * percentage,
        ),
      ]),
    );
    const folds: number[][] = Array.from({ length: this.nSplits }, () => []);

    // _distribute_positive_evidence.
    let l = mostDesiredCombination(samplesWithCombination, combinationSize);
    while (l !== null) {
      const evidence = samplesWithCombination.get(l) ?? [];
      while (evidence.length > 0) {
        const row = evidence.pop() ?? 0;
        if (rowsUsed[row]) continue;
        const desired = desiredPerCombination.get(l) ?? [];
        const m = argmaxAll(desired);
        const foldIndex = this.#foldTieBreak(desired, m);
        folds[foldIndex]?.push(row);
        rowsUsed[row] = true;
        for (const combination of perRowCombinations[row] ?? []) {
          const samples = samplesWithCombination.get(combination) ?? [];
          const position = samples.indexOf(row);
          if (position !== -1) samples.splice(position, 1);
          const desiredOfCombination = desiredPerCombination.get(combination);
          if (desiredOfCombination !== undefined)
            desiredOfCombination[foldIndex] =
              (desiredOfCombination[foldIndex] ?? 0) - 1;
        }
        desiredSamplesPerFold[foldIndex] =
          (desiredSamplesPerFold[foldIndex] ?? 0) - 1;
      }
      l = mostDesiredCombination(samplesWithCombination, combinationSize);
    }

    // _distribute_negative_evidence: the rows left, from the last one.
    const availableSamples = rowsUsed.flatMap((used, index) =>
      used ? [] : [index],
    );
    while (availableSamples.length > 0) {
      const row = availableSamples.pop() ?? 0;
      rowsUsed[row] = true;
      const open = desiredSamplesPerFold.flatMap((desired, index) =>
        desired > 0 ? [index] : [],
      );
      const [foldSelected = 0] = this.#rng.choice(open, 1);
      desiredSamplesPerFold[foldSelected] =
        (desiredSamplesPerFold[foldSelected] ?? 0) - 1;
      folds[foldSelected]?.push(row);
    }
    return folds;
  }

  // _fold_tie_break: the only fold of m, or a random fold among the folds of
  // m that desire the most samples.
  #foldTieBreak(desired: readonly number[], m: readonly number[]): number {
    if (m.length === 1) return m[0] ?? 0;
    const maxValue = Math.max(...m.map((fold) => desired[fold] ?? 0));
    const mPrim = argmaxAll(desired, maxValue).filter((fold) =>
      m.includes(fold),
    );
    const [fold = 0] = this.#rng.choice(mPrim, 1);
    return fold;
  }
}

// np.where(values == max(values))[0], or of the given maximum.
function argmaxAll(
  values: readonly number[],
  maxValue = Math.max(...values),
): number[] {
  return values.flatMap((value, index) => (value === maxValue ? [index] : []));
}

// _get_most_desired_combination: the first combination with samples left,
// replaced only by a later one of more distinct labels and fewer samples.
function mostDesiredCombination(
  samplesWithCombination: ReadonlyMap<Combination, readonly number[]>,
  combinationSize: ReadonlyMap<Combination, number>,
): Combination | null {
  let chosen: Combination | null = null;
  let bestSize = 0;
  let bestSupport = 0;
  for (const [combination, evidence] of samplesWithCombination) {
    const size = combinationSize.get(combination) ?? 0;
    const support = evidence.length;
    if (support === 0) continue;
    if (chosen === null || (bestSize < size && bestSupport > support)) {
      chosen = combination;
      bestSize = size;
      bestSupport = support;
    }
  }
  return chosen;
}

// itertools.combinations_with_replacement(items, r), in its order.
function* combinationsWithReplacement(
  items: readonly number[],
  r: number,
): Generator<number[]> {
  const n = items.length;
  if (n === 0 && r > 0) return;
  const indices = new Array<number>(r).fill(0);
  const combination = () => indices.map((index) => items[index] ?? 0);
  yield combination();
  for (;;) {
    let i = r - 1;
    while (i >= 0 && indices[i] === n - 1) i--;
    if (i < 0) return;
    const next = (indices[i] ?? 0) + 1;
    for (let j = i; j < r; j++) indices[j] = next;
    yield combination();
  }
}
