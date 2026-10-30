import type { Embeddings } from '../types/encoder-io.ts';
import { ddot } from './blas.ts';
import { log } from './libm.ts';
import { sumFloat32 } from './numpy.ts';
import { minimizeLbfgsb } from './scipy-lbfgsb.ts';
import { type ClassLabel, uniqueInverse } from './sklearn.ts';

// sklearn.linear_model.LogisticRegression of scikit-learn 1.9.1
// (linear_model/_logistic.py, _linear_loss.py and the HalfBinomialLoss and
// HalfMultinomialLoss of _loss/_loss.pyx.tp) with the lbfgs solver, the l2
// penalty, an intercept and no sample weights, for float32 data, as MTEB
// calls it. scikit-learn keeps the data in float32: it rounds the
// coefficients to float32 for X @ W' + b and computes the loss and its
// gradient of each sample in float32. This port rounds the same values.
//
// BLAS adds the products of X @ W' and of G' @ X. With Accelerate, sgemm
// adds them in index order with one rounding per fused multiply-add, which
// this port copies; X @ w of two classes goes through sgemv, whose order it
// does not copy. scipy's L-BFGS-B and the penalty add their float64 dot
// products in another order too (scipy-lbfgsb.ts). Thus the coefficients
// can differ from scikit-learn's in their last bits.

export type LogisticRegressionOptions = {
  readonly C?: number;
  readonly tol?: number;
  readonly maxIter?: number;
};

export class LogisticRegression {
  readonly C: number;
  readonly tol: number;
  readonly maxIter: number;

  constructor(options: LogisticRegressionOptions = {}) {
    this.C = options.C ?? 1;
    this.tol = options.tol ?? 1e-4;
    this.maxIter = options.maxIter ?? 100;
  }

  // fit: the coefficients that minimize the mean loss of the samples plus
  // the l2 penalty 1 / (2 C n) * |w|^2.
  fit(x: Embeddings, y: readonly ClassLabel[]): FittedLogisticRegression {
    if (x.length !== y.length)
      throw new Error(
        `Found input variables with inconsistent numbers of samples: [${x.length}, ${y.length}]`,
      );
    const { unique: classes, inverse } = uniqueInverse(y);
    if (classes.length < 2)
      throw new Error(
        `This solver needs samples of at least 2 classes in the data, but the data contains only one class: ${numpyRepr(classes[0])}`,
      );
    const nFeatures = x[0]?.length ?? 0;
    const l2RegStrength = 1 / (this.C * x.length);
    const loss =
      classes.length === 2
        ? binomialLoss(
            x,
            inverse.map((index) => (index === 1 ? 1 : 0)),
            l2RegStrength,
          )
        : multinomialLoss(x, inverse, classes.length, l2RegStrength);
    const nWeights =
      classes.length === 2 ? nFeatures + 1 : classes.length * (nFeatures + 1);
    const result = minimizeLbfgsb(loss, new Float64Array(nWeights), {
      maxiter: this.maxIter,
      maxls: 50,
      gtol: this.tol,
      ftol: 64 * EPSILON,
    });
    const w = Float32Array.from(result.x);
    // _check_optimize_result caps nit at max_iter for SciPy 1.0 and older;
    // SciPy 1.18 stops at maxiter, so nit is n_iter_.
    const nIter = result.nit;
    if (classes.length === 2)
      return new FittedLogisticRegression(
        classes,
        [w.subarray(0, nFeatures)],
        w.subarray(nFeatures),
        nIter,
      );
    const k = classes.length;
    return new FittedLogisticRegression(
      classes,
      classes.map((_, c) =>
        Float32Array.from({ length: nFeatures }, (_, j) => w[c + k * j] ?? 0),
      ),
      Float32Array.from(classes, (_, c) => w[c + k * nFeatures] ?? 0),
      nIter,
    );
  }
}

// A fitted LogisticRegression: one row of coefficients for two classes,
// a row for each class otherwise.
export class FittedLogisticRegression {
  readonly classes: readonly ClassLabel[];
  readonly coef: readonly Float32Array[];
  readonly intercept: Float32Array;
  // n_iter_: the iterations of L-BFGS-B, at most maxIter.
  readonly nIter: number;

  constructor(
    classes: readonly ClassLabel[],
    coef: readonly Float32Array[],
    intercept: Float32Array,
    nIter: number,
  ) {
    this.classes = classes;
    this.coef = coef;
    this.intercept = intercept;
    this.nIter = nIter;
  }

  // decision_function: X @ coef' + intercept in float32, a row of a value
  // for each class, or of one value for two classes.
  decisionFunction(x: Embeddings): Float32Array[] {
    return x.map((row) =>
      Float32Array.from(this.coef, (weights, c) =>
        Math.fround(dotFloat32(row, weights) + (this.intercept[c] ?? 0)),
      ),
    );
  }

  // predict: classes[1] where the value is above 0 for two classes, else
  // the class of the first largest value.
  predict(x: Embeddings): ClassLabel[] {
    return this.decisionFunction(x).map((scores) => {
      let best = 0;
      if (this.coef.length === 1) best = (scores[0] ?? 0) > 0 ? 1 : 0;
      else
        for (let c = 1; c < scores.length; c++)
          if ((scores[c] ?? 0) > (scores[best] ?? 0)) best = c;
      return this.classes[best] ?? 0;
    });
  }
}

const EPSILON = 2.220446049250313e-16;

// The repr of a numpy scalar in numpy 2: np.int64(3), np.str_('a').
function numpyRepr(label: ClassLabel | undefined): string {
  return typeof label === 'string'
    ? `np.str_('${label}')`
    : `np.int64(${String(label)})`;
}

// LinearModelLoss.loss_gradient with HalfBinomialLoss: coef holds the
// weights, then the intercept. y is 1 for the positive class.
function binomialLoss(
  x: Embeddings,
  y: readonly number[],
  l2RegStrength: number,
) {
  const n = x.length;
  const nFeatures = x[0]?.length ?? 0;
  return (coef: Float64Array): readonly [number, Float64Array] => {
    const weights = Float32Array.from(coef.subarray(0, nFeatures));
    const intercept = Math.fround(coef[nFeatures] ?? 0);
    const lossOut = new Float32Array(n);
    const gradientOut = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const raw = Math.fround(
        dotFloat32(x[i] ?? new Float32Array(), weights) + intercept,
      );
      const [loss, gradient] = binomialLossGradient(y[i] ?? 0, raw);
      lossOut[i] = loss;
      gradientOut[i] = gradient;
    }
    let loss = Math.fround(sumFloat32(lossOut) / n);
    loss += 0.5 * l2RegStrength * ddot(nFeatures, coef, 0, coef, 0);
    for (let i = 0; i < n; i++)
      gradientOut[i] = Math.fround((gradientOut[i] ?? 0) / n);
    const grad = new Float64Array(nFeatures + 1);
    for (let j = 0; j < nFeatures; j++) {
      let total = 0;
      for (let i = 0; i < n; i++)
        total = fma32(x[i]?.[j] ?? 0, gradientOut[i] ?? 0, total);
      grad[j] = total + l2RegStrength * (coef[j] ?? 0);
    }
    grad[nFeatures] = sumFloat32(gradientOut);
    return [loss, grad];
  };
}

// closs_grad_half_binomial: the loss log(1 + exp(raw)) - y raw and its
// gradient expit(raw) - y, each rounded to float32.
function binomialLossGradient(y: number, raw: number): [number, number] {
  let loss: number;
  let gradient: number;
  if (raw <= -37) {
    gradient = Math.exp(raw);
    loss = gradient - y * raw;
    gradient -= y;
  } else if (raw <= -2) {
    gradient = Math.exp(raw);
    loss = Math.log1p(gradient) - y * raw;
    gradient = ((1 - y) * gradient - y) / (1 + gradient);
  } else if (raw <= 18) {
    gradient = Math.exp(-raw);
    loss = Math.log1p(gradient) + (1 - y) * raw;
    gradient = (1 - y - y * gradient) / (1 + gradient);
  } else {
    gradient = Math.exp(-raw);
    loss = gradient + (1 - y) * raw;
    gradient = (1 - y - y * gradient) / (1 + gradient);
  }
  return [Math.fround(loss), Math.fround(gradient)];
}

// LinearModelLoss.loss_gradient with HalfMultinomialLoss: coef holds the
// classes of each feature together, then the intercepts
// (coef.reshape((k, -1), order="F")). y is the index of the class.
function multinomialLoss(
  x: Embeddings,
  y: readonly number[],
  k: number,
  l2RegStrength: number,
) {
  const n = x.length;
  const nFeatures = x[0]?.length ?? 0;
  return (coef: Float64Array): readonly [number, Float64Array] => {
    const weights = Array.from({ length: k }, (_, c) =>
      Float32Array.from({ length: nFeatures }, (_, j) => coef[c + k * j] ?? 0),
    );
    const intercept = Float32Array.from(
      { length: k },
      (_, c) => coef[c + k * nFeatures] ?? 0,
    );
    const lossOut = new Float32Array(n);
    const gradientOut = Array.from({ length: n }, () => new Float32Array(k));
    const raw = new Float32Array(k);
    const p = new Float32Array(k);
    for (let i = 0; i < n; i++) {
      const row = x[i] ?? new Float32Array();
      for (let c = 0; c < k; c++)
        raw[c] = Math.fround(
          dotFloat32(row, weights[c] ?? new Float32Array()) +
            (intercept[c] ?? 0),
        );
      // sum_exp_minus_max: the exponentials in float32, their sum in
      // float64.
      let maxValue = raw[0] ?? 0;
      for (let c = 1; c < k; c++)
        if (maxValue < (raw[c] ?? 0)) maxValue = raw[c] ?? 0;
      let sumExps = 0;
      for (let c = 0; c < k; c++) {
        p[c] = Math.exp((raw[c] ?? 0) - maxValue);
        sumExps += p[c] ?? 0;
      }
      const sumExps32 = Math.fround(sumExps);
      let loss = Math.fround(log(sumExps32) + maxValue);
      const gradient = gradientOut[i] ?? new Float32Array(k);
      for (let c = 0; c < k; c++) {
        const isClass = y[i] === c;
        if (isClass) loss = Math.fround(loss - (raw[c] ?? 0));
        p[c] = Math.fround((p[c] ?? 0) / sumExps32);
        gradient[c] = Math.fround((p[c] ?? 0) - (isClass ? 1 : 0));
      }
      lossOut[i] = loss;
    }
    let loss = Math.fround(sumFloat32(lossOut) / n);
    loss += 0.5 * l2RegStrength * ddot(k * nFeatures, coef, 0, coef, 0);
    for (const gradient of gradientOut)
      for (let c = 0; c < k; c++)
        gradient[c] = Math.fround((gradient[c] ?? 0) / n);
    const grad = new Float64Array(k * (nFeatures + 1));
    for (let c = 0; c < k; c++) {
      for (let j = 0; j < nFeatures; j++) {
        let total = 0;
        for (let i = 0; i < n; i++)
          total = fma32(gradientOut[i]?.[c] ?? 0, x[i]?.[j] ?? 0, total);
        grad[c + k * j] = total + l2RegStrength * (coef[c + k * j] ?? 0);
      }
      // np.sum(axis=0) of a C-contiguous array adds the rows in order.
      let total = 0;
      for (const gradient of gradientOut)
        total = Math.fround(total + (gradient[c] ?? 0));
      grad[c + k * nFeatures] = total;
    }
    return [loss, grad];
  };
}

// The float32 dot product of a and b as sgemm adds it: in index order, one
// fused multiply-add each.
function dotFloat32(a: Float32Array, b: Float32Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total = fma32(a[i] ?? 0, b[i] ?? 0, total);
  return total;
}

const bits = new Float32Array(1);
const words = new Uint32Array(bits.buffer);

// fmaf(a, b, c) of float32 values: a * b + c rounded once to float32. The
// product is exact in float64; the float64 sum can round onto the midpoint
// of two float32 values, so its rounding error decides that tie.
function fma32(a: number, b: number, c: number): number {
  const product = a * b;
  const sum = product + c;
  const rounded = Math.fround(sum);
  if (rounded === sum) return rounded;
  const bb = sum - product;
  const error = product - (sum - bb) + (c - bb);
  if (error === 0) return rounded;
  bits[0] = rounded;
  if (rounded === 0) words[0] = sum > 0 ? 1 : 0x8000_0001;
  else if (sum > rounded === rounded > 0) words[0] = (words[0] ?? 0) + 1;
  else words[0] = (words[0] ?? 0) - 1;
  const other = bits[0] ?? 0;
  if (sum !== (rounded + other) / 2) return rounded;
  return error > 0 === other > rounded ? other : rounded;
}
