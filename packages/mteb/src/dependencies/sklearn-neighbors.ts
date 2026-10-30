import { availableParallelism } from 'node:os';

import type { Embeddings } from '../types/encoder-io.ts';
import { ddot } from './blas.ts';
import { type LabelIndicator, accuracyScore } from './sklearn.ts';

// sklearn.neighbors.KNeighborsClassifier of scikit-learn 1.9.1
// (neighbors/_classification.py, _base.py) with the uniform weights and the
// euclidean metric, for dense float32 data and a label indicator matrix, as
// MTEB's multilabel classification calls it. It finds the neighbours by
// brute force, as EuclideanArgKmin32 does (metrics/_pairwise_distances_
// reduction): the squared distance is |x|^2 - 2 x.y + |y|^2 in float64, each
// training row in index order goes on a max-heap of k (utils/_heap.pyx), and
// the heap is sorted by insertion sort (utils/_sorting.pyx, which uses it for
// up to 15 values). BLAS (dgemm and ddot) adds the dot products in its own
// order; here each dot product adds in index order, so a squared distance
// can differ in its last bits. The distance is the square root of the
// squared distance as a float32, rounded to a float32 again
// (EuclideanDistance32). When the test rows are fewer than the training
// rows, scikit-learn splits the training rows among its threads
// (parallel_on_Y) and merges their heaps; the port does the same with
// os.availableParallelism() threads. scikit-learn takes
// _openmp_effective_n_threads() (_base.pyx.tp, utils/_openmp_helpers.pyx):
// OMP_NUM_THREADS when it is set, else the smaller of OpenMP's count and the
// physical cores, under a cgroup CPU quota. The two counts are equal when
// the logical cores are the physical cores and no quota or OMP_NUM_THREADS
// applies; backlog #3460 ports the rest. The thread count changes which of
// two rows at the same distance stays. scikit-learn uses a KD tree for 15
// features or fewer when n_neighbors is below half the training rows; the KD
// tree finds the same neighbours, but it can keep another of two rows at the
// same distance. This port finds them by brute force in every case.
const MAX_SORTED_NEIGHBORS = 15;
// pairwise_dist_chunk_size: the rows of a chunk.
const CHUNK_SIZE = 256;

export class KNeighborsClassifier {
  readonly nNeighbors: number;

  constructor(options: { readonly nNeighbors?: number } = {}) {
    this.nNeighbors = options.nNeighbors ?? 5;
    if (this.nNeighbors > MAX_SORTED_NEIGHBORS)
      throw new RangeError(
        `This port sorts ${MAX_SORTED_NEIGHBORS} neighbours or fewer.`,
      );
  }

  // fit(X, y) with y a label indicator matrix: each column is an output
  // with its own classes (np.unique of the column).
  fit(x: Embeddings, y: LabelIndicator): FittedKNeighborsClassifier {
    if (x.length === 0)
      throw new Error(
        'Found array with 0 sample(s) (shape=(0, 0)) while a minimum of 1 is required by KNeighborsClassifier.',
      );
    if (x.length !== y.length)
      throw new Error(
        `Found input variables with inconsistent numbers of samples: [${x.length}, ${y.length}]`,
      );
    return new FittedKNeighborsClassifier(this.nNeighbors, x, y);
  }
}

export class FittedKNeighborsClassifier {
  readonly nNeighbors: number;
  readonly #fitX: Float64Array[];
  readonly #fitNormsSquared: number[];
  // classes_: the sorted values of each output.
  readonly classes: number[][];
  // _y: the index of the value of each row among the classes of its output.
  readonly #y: number[][];
  readonly #nFeatures: number;

  constructor(nNeighbors: number, x: Embeddings, y: LabelIndicator) {
    this.nNeighbors = nNeighbors;
    this.#nFeatures = x[0]?.length ?? 0;
    this.#fitX = x.map((row) => Float64Array.from(row));
    this.#fitNormsSquared = this.#fitX.map((row) =>
      ddot(row.length, row, 0, row, 0),
    );
    const outputs = y[0]?.length ?? 0;
    this.classes = Array.from({ length: outputs }, (_, k) =>
      [...new Set(y.map((row) => row[k] ?? 0))].sort((a, b) => a - b),
    );
    this.#y = y.map((row) =>
      row.map((value, k) => this.classes[k]?.indexOf(value) ?? 0),
    );
  }

  // kneighbors(X): the distances and the indices of the nNeighbors nearest
  // training rows of each row of x, nearest first.
  kneighbors(x: Embeddings): {
    readonly distances: number[][];
    readonly indices: number[][];
  } {
    const k = this.nNeighbors;
    const nSamplesFit = this.#fitX.length;
    if (k > nSamplesFit)
      throw new Error(
        `Expected n_neighbors <= n_samples_fit, but n_neighbors = ${k}, n_samples_fit = ${nSamplesFit}, n_samples = ${x.length}`,
      );
    // strategy="auto" of BaseDistancesReduction: parallel_on_Y when the
    // test rows are fewer than the training rows and too few to keep the
    // threads busy. parallel_on_X runs all the training rows of a test row
    // on one heap.
    const threads = availableParallelism();
    const parallelOnY =
      nSamplesFit >= x.length && !(4 * CHUNK_SIZE * threads < x.length);
    const threadBlocks = staticBlocks(nSamplesFit, threads);
    const distances: number[][] = [];
    const indices: number[][] = [];
    for (const row of x) {
      if (row.length !== this.#nFeatures)
        throw new Error(
          `X has ${row.length} features, but KNeighborsClassifier is expecting ${this.#nFeatures} features as input.`,
        );
      const query = Float64Array.from(row);
      const queryNormSquared = ddot(query.length, query, 0, query, 0);
      const squaredDistance = (j: number) =>
        Math.max(
          0,
          queryNormSquared +
            -2 * ddot(query.length, query, 0, this.#fitX[j] ?? query, 0) +
            (this.#fitNormsSquared[j] ?? 0),
        );
      const values = new Array<number>(k).fill(Number.MAX_VALUE);
      const heapIndices = new Array<number>(k).fill(-1);
      if (parallelOnY)
        for (const block of threadBlocks) {
          // Each thread keeps a heap of its own rows; the main heap then
          // takes the values of each thread's heap, in their order there.
          const threadValues = new Array<number>(k).fill(Number.MAX_VALUE);
          const threadIndices = new Array<number>(k).fill(-1);
          for (let j = block.start; j < block.end; j++)
            heapPush(threadValues, threadIndices, squaredDistance(j), j);
          for (const [index, value] of threadValues.entries())
            heapPush(values, heapIndices, value, threadIndices[index] ?? -1);
        }
      else
        for (let j = 0; j < nSamplesFit; j++)
          heapPush(values, heapIndices, squaredDistance(j), j);
      insertionSort(values, heapIndices);
      // compute_exact_distances: _rdist_to_dist of EuclideanDistance32 takes
      // and returns a float32.
      distances.push(
        values.map((value) =>
          Math.fround(Math.sqrt(Math.fround(Math.max(value, 0)))),
        ),
      );
      indices.push(heapIndices);
    }
    return { distances, indices };
  }

  // predict(X) of several outputs: predict_proba counts the classes of the
  // neighbours of each output, and the class of the largest count wins; of
  // equal counts, the first class wins (np.argmax).
  predict(x: Embeddings): number[][] {
    const { indices } = this.kneighbors(x);
    return indices.map((neighbors) =>
      this.classes.map((classes, k) => {
        const votes = new Array<number>(classes.length).fill(0);
        for (const neighbor of neighbors) {
          const label = this.#y[neighbor]?.[k] ?? 0;
          votes[label] = (votes[label] ?? 0) + 1;
        }
        let best = 0;
        for (const [index, count] of votes.entries())
          if (count > (votes[best] ?? 0)) best = index;
        return classes[best] ?? 0;
      }),
    );
  }

  // ClassifierMixin.score: the accuracy of the predictions, which for a
  // label indicator matrix is the share of rows with all labels right.
  score(x: Embeddings, y: LabelIndicator): number {
    return accuracyScore(y, this.predict(x));
  }
}

// heap_push of utils/_heap.pyx: a fixed-size max-heap that keeps the
// smallest values. A value equal to the largest one stays out.
function heapPush(
  values: number[],
  indices: number[],
  value: number,
  valueIndex: number,
): void {
  const size = values.length;
  if (value >= (values[0] ?? 0)) return;
  let current = 0;
  for (;;) {
    const left = 2 * current + 1;
    const right = left + 1;
    let swap: number;
    if (left >= size) break;
    else if (right >= size) {
      if ((values[left] ?? 0) > value) swap = left;
      else break;
    } else if ((values[left] ?? 0) >= (values[right] ?? 0)) {
      if (value < (values[left] ?? 0)) swap = left;
      else break;
    } else if (value < (values[right] ?? 0)) swap = right;
    else break;
    values[current] = values[swap] ?? 0;
    indices[current] = indices[swap] ?? 0;
    current = swap;
  }
  values[current] = value;
  indices[current] = valueIndex;
}

// insertion_sort of utils/_sorting.pyx: values and indices together, by
// value. Equal values keep their order.
function insertionSort(values: number[], indices: number[]): void {
  for (let i = 1; i < values.length; i++) {
    const value = values[i] ?? 0;
    const index = indices[i] ?? 0;
    let j = i;
    while (j > 0 && (values[j - 1] ?? 0) > value) {
      values[j] = values[j - 1] ?? 0;
      indices[j] = indices[j - 1] ?? 0;
      j--;
    }
    values[j] = value;
    indices[j] = index;
  }
}

// The training rows of each thread in parallel_on_Y: chunks of CHUNK_SIZE
// rows, and min(chunks, threads) threads that take contiguous blocks of
// chunks (OpenMP's static schedule: the first chunks % threads threads take
// one chunk more).
function staticBlocks(
  nSamples: number,
  threads: number,
): { readonly start: number; readonly end: number }[] {
  const chunks = Math.ceil(nSamples / CHUNK_SIZE);
  const used = Math.min(chunks, threads);
  const blocks: { start: number; end: number }[] = [];
  let chunk = 0;
  for (let thread = 0; thread < used; thread++) {
    const count = Math.floor(chunks / used) + (thread < chunks % used ? 1 : 0);
    blocks.push({
      start: chunk * CHUNK_SIZE,
      end: Math.min((chunk + count) * CHUNK_SIZE, nSamples),
    });
    chunk += count;
  }
  return blocks;
}
