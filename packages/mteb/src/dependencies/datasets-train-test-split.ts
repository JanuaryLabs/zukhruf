// Dataset.train_test_split of datasets 5.1.0 with an int test_size, a seed
// and stratify_by_column (datasets/arrow_dataset.py), and
// datasets/utils/stratify.py, which adapts the StratifiedShuffleSplit of
// scikit-learn: the first split of stratified_shuffle_split_generate_indices.
// MTEB's regression tasks call it to subsample their training rows. The
// split without stratification, the split without a shuffle and the checks of
// the sizes are not ported: MTEB does not reach them.
import { type Dataset, type DatasetDict, select } from './datasets.ts';
import { NumpyGenerator } from './numpy-random.ts';

// The train and the test rows: the test side holds testSize rows, the train
// side the others. The rows of each side are in the order of a permutation.
// The stratify column holds the int ids of the classes, as a ClassLabel
// column stores them.
export function trainTestSplit(
  dataset: Dataset,
  options: {
    readonly testSize: number;
    readonly seed: number;
    readonly stratifyByColumn: string;
  },
): DatasetDict {
  const { testSize, seed, stratifyByColumn } = options;
  const nTest = testSize;
  const nTrain = dataset.rows.length - nTest;
  const generator = new NumpyGenerator(seed);
  const y = dataset.rows.map((row) => {
    const value = row[stratifyByColumn];
    if (typeof value !== 'number' || !Number.isInteger(value))
      throw new TypeError(
        `The column ${stratifyByColumn} holds ${String(value)}, not the id of a class.`,
      );
    return value;
  });
  // np.unique of the ids, then the rows of each class in increasing order.
  const rowsByClass = new Map<number, number[]>();
  for (const [row, label] of y.entries()) {
    const rows = rowsByClass.get(label);
    if (rows === undefined) rowsByClass.set(label, [row]);
    else rows.push(row);
  }
  const classIndices = [...rowsByClass]
    .sort(([a], [b]) => a - b)
    .map(([, rows]) => rows);
  const classCounts = classIndices.map((rows) => rows.length);
  if (Math.min(...classCounts) < 2)
    throw new Error(
      `The least populated class in ${stratifyByColumn} column has only 1 member, which is too few. The minimum number of groups for any class cannot be less than 2.`,
    );
  if (nTrain < classIndices.length)
    throw new Error(
      `The train_size = ${nTrain} should be greater or equal to the number of classes = ${classIndices.length}`,
    );
  if (nTest < classIndices.length)
    throw new Error(
      `The test_size = ${nTest} should be greater or equal to the number of classes = ${classIndices.length}`,
    );
  const nI = approximateMode(classCounts, nTrain, generator);
  const tI = approximateMode(
    classCounts.map((count, i) => count - (nI[i] ?? 0)),
    nTest,
    generator,
  );
  const train: number[] = [];
  const test: number[] = [];
  for (const [i, indices] of classIndices.entries()) {
    const permuted = generator
      .permutation(indices.length)
      .map((position) => indices[position] ?? 0);
    const trainCount = nI[i] ?? 0;
    train.push(...permuted.slice(0, trainCount));
    test.push(...permuted.slice(trainCount, trainCount + (tI[i] ?? 0)));
  }
  const trainIndices = generator.permutation(train);
  const testIndices = generator.permutation(test);
  return new Map([
    ['train', select(dataset, trainIndices)],
    ['test', select(dataset, testIndices)],
  ]);
}

// approximate_mode: the number of draws of each class, the floor of its share
// of nDraws plus one for the largest remainders. Equal remainders take the
// extra draws in a random choice of their classes.
function approximateMode(
  classCounts: readonly number[],
  nDraws: number,
  generator: NumpyGenerator,
): number[] {
  const total = classCounts.reduce((sum, count) => sum + count, 0);
  const continuous = classCounts.map((count) => (nDraws * count) / total);
  const floored = continuous.map(Math.floor);
  let needToAdd = nDraws - floored.reduce((sum, value) => sum + value, 0);
  if (needToAdd > 0) {
    const remainder = continuous.map((value, i) => value - (floored[i] ?? 0));
    const values = [...new Set(remainder)].sort((a, b) => b - a);
    for (const value of values) {
      const inds = remainder.flatMap((r, i) => (r === value ? [i] : []));
      const addNow = Math.min(inds.length, needToAdd);
      for (const i of generator.choiceWithoutReplacement(inds, addNow))
        floored[i] = (floored[i] ?? 0) + 1;
      needToAdd -= addNow;
      if (needToAdd === 0) break;
    }
  }
  return floored;
}
