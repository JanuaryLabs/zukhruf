import { QuantileMethod } from './quantile-method.ts';

// numpy.quantile(method='higher'): the value at ceil((n - 1)q).
export class Higher extends QuantileMethod {
  protected valueAt(sorted: readonly number[], q: number): number {
    return QuantileMethod.value(sorted, Math.ceil((sorted.length - 1) * q));
  }
}
