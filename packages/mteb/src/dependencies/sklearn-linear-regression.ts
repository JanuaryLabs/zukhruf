// sklearn.linear_model.LinearRegression of scikit-learn 1.9.1 with its
// defaults (fit_intercept, tol 1e-6, no sample weights), for dense float32
// data, as MTEB's regression tasks call it. fit keeps the dtype of X:
// _preprocess_data casts y to float32, centres X by its float32 column means
// and y by its float32 mean, and scipy.linalg.lstsq solves the centred
// problem (dependencies/scipy-linalg.ts). The intercept and the predictions
// come from float32 dot products, which numpy gives to BLAS (sdot, sgemv);
// the port adds each dot product in float64 and rounds it once.
import type { Embeddings } from '../types/encoder-io.ts';
import { ddot } from './blas.ts';
import { meanAxis0Float32, meanFloat32 } from './numpy.ts';
import { lstsq } from './scipy-linalg.ts';

export class LinearRegression {
  readonly tol = 1e-6;

  fit(x: Embeddings, y: readonly number[]): FittedLinearRegression {
    if (x.length !== y.length)
      throw new Error(
        `Found input variables with inconsistent numbers of samples: [${x.length}, ${y.length}]`,
      );
    const xOffset = meanAxis0Float32(x);
    const centredX = x.map((row) =>
      row.map((value, column) => value - (xOffset[column] ?? 0)),
    );
    const y32 = Float32Array.from(y);
    const yOffset = meanFloat32(y32);
    const centredY = y32.map((value) => value - yOffset);
    const { x: solution, rank, s } = lstsq(centredX, centredY, this.tol);
    const coef = Float32Array.from(solution);
    const intercept = Math.fround(
      yOffset - Math.fround(ddot(coef.length, xOffset, 0, coef, 0)),
    );
    return new FittedLinearRegression(
      coef,
      intercept,
      rank,
      Float32Array.from(s),
    );
  }
}

// A fitted LinearRegression: coef_, intercept_, rank_ and singular_ of the
// estimator.
export class FittedLinearRegression {
  readonly coef: Float32Array;
  readonly intercept: number;
  readonly rank: number;
  readonly singular: Float32Array;

  constructor(
    coef: Float32Array,
    intercept: number,
    rank: number,
    singular: Float32Array,
  ) {
    this.coef = coef;
    this.intercept = intercept;
    this.rank = rank;
    this.singular = singular;
  }

  // X @ coef_ + intercept_, in float32.
  predict(x: Embeddings): Float32Array {
    return Float32Array.from(
      x,
      (row) =>
        Math.fround(ddot(this.coef.length, row, 0, this.coef, 0)) +
        this.intercept,
    );
  }
}
