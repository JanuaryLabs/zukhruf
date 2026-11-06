import { QuantileMethod } from './quantile-method.ts';

// numpy.quantile(method='linear'), the default of NumPy: the line between the
// values around the index (n - 1)q, as NumPy's _lerp computes it. From the
// middle on, _lerp goes back from the upper value, so a fraction of 0.5 or
// more gives other bits than a + (b - a)t.
export class Linear extends QuantileMethod {
  protected valueAt(sorted: readonly number[], q: number): number {
    const position = (sorted.length - 1) * q;
    const below = Math.floor(position);
    const a = QuantileMethod.value(sorted, below);
    const b = QuantileMethod.value(
      sorted,
      Math.min(below + 1, sorted.length - 1),
    );
    const t = position - below;
    const difference = b - a;
    return t >= 0.5 ? b - difference * (1 - t) : a + difference * t;
  }
}
