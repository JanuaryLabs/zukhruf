// A rule that gives the value at the quantile q of sorted values: a method of
// numpy.quantile, with NumPy's name. q is from 0 to 1, as NumPy requires. A
// subclass gives only where its rule reads the values (Template Method).
export abstract class QuantileMethod {
  of(sorted: readonly number[], q: number): number {
    if (!(q >= 0 && q <= 1))
      throw new RangeError(`A quantile is from 0 to 1, not ${q}`);
    if (sorted.length === 0)
      throw new RangeError('A quantile needs at least one value');
    return this.valueAt(sorted, q);
  }

  protected abstract valueAt(sorted: readonly number[], q: number): number;

  // The value at an index that the rule computed, which is always in range.
  protected static value(sorted: readonly number[], index: number): number {
    const value = sorted[index];
    if (value === undefined)
      throw new RangeError(`No value at the index ${index}`);
    return value;
  }
}
