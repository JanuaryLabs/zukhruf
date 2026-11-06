import { QuantileMethod } from './quantile-method.ts';

// numpy.quantile(method='inverted_cdf'), the nearest rank: NumPy reads the
// index nq - 1, keeps it when it is whole and else takes the next one, and
// reads the first value below 0.
export class InvertedCdf extends QuantileMethod {
  protected valueAt(sorted: readonly number[], q: number): number {
    const index = sorted.length * q - 1;
    const previous = Math.floor(index);
    const picked = index - previous === 0 ? previous : previous + 1;
    return QuantileMethod.value(sorted, Math.max(picked, 0));
  }
}
