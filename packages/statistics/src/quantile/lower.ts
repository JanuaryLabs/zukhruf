import { QuantileMethod } from './quantile-method.ts';

// numpy.quantile(method='lower'): the value at floor((n - 1)q).
export class Lower extends QuantileMethod {
  protected valueAt(sorted: readonly number[], q: number): number {
    return QuantileMethod.value(sorted, Math.floor((sorted.length - 1) * q));
  }
}
