import type { Embeddings } from '../types/encoder-io.ts';
import { ddot } from './blas.ts';
import { log } from './libm.ts';
import { RandomState } from './numpy-random.ts';
import { argsortStable } from './numpy.ts';
import { rowNorms } from './sklearn.ts';

// sklearn.cluster.MiniBatchKMeans of scikit-learn 1.9.1 (cluster/_kmeans.py,
// _k_means_minibatch.pyx, _k_means_lloyd.pyx, _k_means_common.pyx) for dense
// float32 data, k-means++, unit sample weights and tol 0, as MTEB calls it.
// The draws of the legacy RandomState are numpy's, so with the same labels
// at each step, the minibatches, the reassignments and the center updates
// are numpy's to the last bit. BLAS adds the dot products of the distances
// in an order that this port does not copy: each dot product here is a
// float64 sum, rounded once. Thus a distance can differ in its last float32
// bit, and a sample at almost the same distance from two centers can take
// another label.

export type MiniBatchKMeansOptions = {
  readonly nClusters: number;
  readonly batchSize?: number;
  // "auto" and 1 both give one initialization for k-means++.
  readonly nInit?: 1 | 'auto';
  readonly randomState: number;
  readonly maxIter?: number;
  readonly maxNoImprovement?: number;
  readonly reassignmentRatio?: number;
};

export class MiniBatchKMeans {
  readonly nClusters: number;
  readonly batchSize: number;
  readonly randomState: number;
  readonly maxIter: number;
  readonly maxNoImprovement: number;
  readonly reassignmentRatio: number;
  clusterCenters: Float32Array[] = [];
  labels: number[] = [];
  nSteps = 0;

  constructor(options: MiniBatchKMeansOptions) {
    this.nClusters = options.nClusters;
    this.batchSize = options.batchSize ?? 1024;
    this.randomState = options.randomState;
    this.maxIter = options.maxIter ?? 100;
    this.maxNoImprovement = options.maxNoImprovement ?? 10;
    this.reassignmentRatio = options.reassignmentRatio ?? 0.01;
  }

  fitPredict(x: Embeddings): number[] {
    return this.fit(x).labels;
  }

  fit(x: Embeddings): this {
    const nSamples = x.length;
    if (nSamples < this.nClusters)
      throw new Error(
        `n_samples=${nSamples} should be >= n_clusters=${this.nClusters}.`,
      );
    const batchSize = Math.min(this.batchSize, nSamples);
    let initSize = 3 * batchSize;
    if (initSize < this.nClusters) initSize = 3 * this.nClusters;
    initSize = Math.min(initSize, nSamples);
    const random = new RandomState(this.randomState);
    // The validation set of the inits: with one init, its inertia chooses
    // nothing, but its indices are drawn.
    random.randint(0, nSamples, initSize);
    const initSamples =
      initSize < nSamples
        ? random.randint(0, nSamples, initSize).map((index) => rowOf(x, index))
        : x;
    let centers: Float32Array[] = kmeansPlusPlus(
      initSamples,
      this.nClusters,
      random,
    );
    let centersNew: Float32Array[] = centers.map(
      (center) => new Float32Array(center.length),
    );
    const counts = new Float32Array(this.nClusters);
    const convergence = new Convergence(
      batchSize,
      nSamples,
      this.maxNoImprovement,
    );
    let sinceLastReassign = 0;
    const nSteps = Math.floor((this.maxIter * nSamples) / batchSize);
    const weight = Math.fround(1 / Math.fround(nSamples));
    const normalizedWeights = new Float32Array(nSamples).fill(weight);
    let step = 0;
    for (; step < nSteps; step++) {
      const batch = random
        .choiceWithProbabilities(normalizedWeights, batchSize)
        .map((index) => rowOf(x, index));
      sinceLastReassign += batchSize;
      let randomReassign = false;
      if (
        counts.some((count) => count === 0) ||
        sinceLastReassign >= 10 * this.nClusters
      ) {
        sinceLastReassign = 0;
        randomReassign = true;
      }
      const batchInertia = this.#miniBatchStep(
        batch,
        centers,
        centersNew,
        counts,
        random,
        randomReassign,
      );
      [centers, centersNew] = [centersNew, centers];
      if (convergence.converged(step, batchInertia)) break;
    }
    this.clusterCenters = centers;
    this.nSteps = Math.min(step + 1, nSteps);
    this.labels = labelsInertia(x, centers).labels;
    return this;
  }

  // _mini_batch_step with unit weights: the labels of the batch, the update
  // of each center, then the random reassignment of the centers with low
  // counts. It returns the inertia of the batch before the update.
  #miniBatchStep(
    batch: Embeddings,
    centers: readonly Float32Array[],
    centersNew: Float32Array[],
    counts: Float32Array,
    random: RandomState,
    randomReassign: boolean,
  ): number {
    const { labels, inertia } = labelsInertia(batch, centers);
    for (const [cluster, center] of centers.entries())
      updateCenter(cluster, batch, labels, center, centersNew, counts);
    if (!randomReassign || this.reassignmentRatio <= 0) return inertia;
    let largest = -Infinity;
    for (const count of counts) largest = Math.max(largest, count);
    const threshold = Math.fround(this.reassignmentRatio * largest);
    const toReassign = Array.from(counts, (count) => count < threshold);
    const half = 0.5 * batch.length;
    if (toReassign.filter(Boolean).length > half)
      // numpy's argsort (introsort) and this stable sort can order equal
      // counts in another way.
      for (const index of argsortStable(counts).slice(Math.floor(half)))
        toReassign[index] = false;
    const nReassigns = toReassign.filter(Boolean).length;
    if (nReassigns === 0) return inertia;
    const newCenters = random.choiceWithoutReplacement(
      batch.length,
      nReassigns,
    );
    let next = 0;
    for (const [cluster, reassign] of toReassign.entries())
      if (reassign)
        centersNew[cluster] = Float32Array.from(
          rowOf(batch, newCenters[next++] ?? 0),
        );
    let smallest = Infinity;
    for (const [cluster, count] of counts.entries())
      if (!toReassign[cluster]) smallest = Math.min(smallest, count);
    for (const [cluster, reassign] of toReassign.entries())
      if (reassign) counts[cluster] = smallest;
    return inertia;
  }
}

// _mini_batch_convergence without tol: an exponentially weighted average of
// the mean inertia of the batches, in float32, and a stop after
// maxNoImprovement steps without a new minimum.
class Convergence {
  readonly #batchSize: number;
  readonly #alpha: number;
  readonly #maxNoImprovement: number;
  #ewaInertia: number | null = null;
  #ewaInertiaMin: number | null = null;
  #noImprovement = 0;

  constructor(batchSize: number, nSamples: number, maxNoImprovement: number) {
    this.#batchSize = batchSize;
    this.#alpha = Math.min((batchSize * 2) / (nSamples + 1), 1);
    this.#maxNoImprovement = maxNoImprovement;
  }

  converged(step: number, batchInertia: number): boolean {
    const inertia = Math.fround(batchInertia / this.#batchSize);
    // The first step has the inertia of the initialization.
    if (step === 0) return false;
    this.#ewaInertia =
      this.#ewaInertia === null
        ? inertia
        : Math.fround(
            Math.fround(this.#ewaInertia * (1 - this.#alpha)) +
              Math.fround(inertia * this.#alpha),
          );
    if (
      this.#ewaInertiaMin === null ||
      this.#ewaInertia < this.#ewaInertiaMin
    ) {
      this.#noImprovement = 0;
      this.#ewaInertiaMin = this.#ewaInertia;
    } else this.#noImprovement++;
    return this.#noImprovement >= this.#maxNoImprovement;
  }
}

function rowOf(x: Embeddings, index: number): Float32Array {
  const row = x[index];
  if (row === undefined) throw new RangeError(`No row ${index}.`);
  return row;
}

// _kmeans_plusplus with unit weights: the first center drawn uniformly, then
// for each center the best of 2 + int(log(k)) candidates drawn in proportion
// to the squared distance to the closest center.
function kmeansPlusPlus(
  x: Embeddings,
  nClusters: number,
  random: RandomState,
): Float32Array[] {
  const nSamples = x.length;
  const nLocalTrials = 2 + Math.trunc(log(nClusters));
  const probability = Math.fround(1 / Math.fround(nSamples));
  const [first = 0] = random.choiceWithProbabilities(
    new Float32Array(nSamples).fill(probability),
    1,
  );
  const centers = [rowOf(x, first)];
  const norms = x.map((row) => ddot(row.length, row, 0, row, 0));
  let closest = squaredDistances(rowOf(x, first), x, norms);
  let currentPot = float32Sum(closest);
  for (let c = 1; c < nClusters; c++) {
    const cumulative = new Float32Array(nSamples);
    let total = 0;
    for (const [index, distance] of closest.entries()) {
      total = Math.fround(total + distance);
      cumulative[index] = total;
    }
    const candidates = random
      .uniform(nLocalTrials)
      .map((value) =>
        Math.min(
          searchsortedLeft(cumulative, value * currentPot),
          nSamples - 1,
        ),
      );
    let best = -1;
    let bestPot = Infinity;
    let bestDistances = closest;
    for (const [trial, candidate] of candidates.entries()) {
      const distances = squaredDistances(rowOf(x, candidate), x, norms).map(
        (distance, index) => Math.min(closest[index] ?? 0, distance),
      );
      const pot = float32Sum(distances);
      if (pot < bestPot || trial === 0) {
        best = candidate;
        bestPot = pot;
        bestDistances = distances;
      }
    }
    currentPot = bestPot;
    closest = bestDistances;
    centers.push(rowOf(x, best));
  }
  return centers.map((center) => Float32Array.from(center));
}

// _euclidean_distances(center, X, squared=True) of float32 data: in float64,
// -2 * center . x + |center|^2 + |x|^2, at least 0, as float32.
function squaredDistances(
  center: Float32Array,
  x: Embeddings,
  norms: readonly number[],
): Float32Array {
  const centerNorm = ddot(center.length, center, 0, center, 0);
  return Float32Array.from(x, (row, index) =>
    Math.max(
      -2 * ddot(center.length, center, 0, row, 0) +
        centerNorm +
        (norms[index] ?? 0),
      0,
    ),
  );
}

// A float32 sum, here a dot product with unit weights (BLAS sgemv): the
// float64 sum, rounded once.
function float32Sum(values: Float32Array): number {
  let total = 0;
  for (const value of values) total += value;
  return Math.fround(total);
}

// np.searchsorted(sorted, value), side "left".
function searchsortedLeft(sorted: Float32Array, value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] ?? 0) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

// _labels_inertia with unit weights: the closest center of each sample by
// |c|^2 - 2 x . c in float32 (lloyd_iter_chunked_dense), the first on a tie,
// and the float32 sum of the squared distances to the closest centers
// (_inertia_dense).
function labelsInertia(
  x: Embeddings,
  centers: readonly Float32Array[],
): { labels: number[]; inertia: number } {
  const centerNorms = rowNorms(centers, true);
  let inertia = 0;
  const labels = x.map((row) => {
    let label = 0;
    let smallest = Infinity;
    for (const [cluster, center] of centers.entries()) {
      const distance = Math.fround(
        (centerNorms[cluster] ?? 0) - 2 * ddot(row.length, row, 0, center, 0),
      );
      if (cluster === 0 || distance < smallest) {
        smallest = distance;
        label = cluster;
      }
    }
    inertia = Math.fround(
      inertia + euclideanDenseDense(row, centers[label] ?? row),
    );
    return label;
  });
  return { labels, inertia };
}

// _euclidean_dense_dense, squared: float32 sums, unrolled by 4.
function euclideanDenseDense(a: Float32Array, b: Float32Array): number {
  const square = (index: number) => {
    const difference = Math.fround((a[index] ?? 0) - (b[index] ?? 0));
    return Math.fround(difference * difference);
  };
  let result = 0;
  const unrolled = a.length - (a.length % 4);
  for (let index = 0; index < unrolled; index += 4) {
    const group = Math.fround(
      Math.fround(
        Math.fround(square(index) + square(index + 1)) + square(index + 2),
      ) + square(index + 3),
    );
    result = Math.fround(result + group);
  }
  for (let index = unrolled; index < a.length; index++)
    result = Math.fround(result + square(index));
  return result;
}

// update_center_dense with unit weights: the center scaled by its count,
// plus the samples of its label, divided by the new count, all in float32.
function updateCenter(
  cluster: number,
  batch: Embeddings,
  labels: readonly number[],
  center: Float32Array,
  centersNew: Float32Array[],
  counts: Float32Array,
): void {
  const target = centersNew[cluster] ?? new Float32Array(center.length);
  centersNew[cluster] = target;
  const members = batch.filter((_, index) => labels[index] === cluster);
  if (members.length === 0) {
    target.set(center);
    return;
  }
  let weightSum = 0;
  for (let index = 0; index < members.length; index++)
    weightSum = Math.fround(weightSum + 1);
  const count = counts[cluster] ?? 0;
  for (let feature = 0; feature < center.length; feature++)
    target[feature] = (center[feature] ?? 0) * count;
  for (const member of members)
    for (let feature = 0; feature < center.length; feature++)
      target[feature] = (target[feature] ?? 0) + (member[feature] ?? 0);
  counts[cluster] = count + weightSum;
  const alpha = Math.fround(1 / (counts[cluster] ?? 1));
  for (let feature = 0; feature < center.length; feature++)
    target[feature] = (target[feature] ?? 0) * alpha;
}
