// A running sum with Neumaier's compensated summation (Neumaier 1974), the
// algorithm of the sum() of CPython 3.12 for floats (Python/bltinmodule.c,
// builtin_sum_impl), so a sum here equals Python's to the last bit: it starts
// at 0, and it adds the compensation only when that is not 0 and is finite.
export class NeumaierSum {
  #sum = 0;
  #compensation = 0;

  // The sum() of the values, in their order.
  static of(values: Iterable<number>): number {
    const sum = new NeumaierSum();
    for (const value of values) sum.add(value);
    return sum.value;
  }

  add(value: number): void {
    const total = this.#sum + value;
    this.#compensation +=
      Math.abs(this.#sum) >= Math.abs(value)
        ? this.#sum - total + value
        : value - total + this.#sum;
    this.#sum = total;
  }

  get value(): number {
    return this.#compensation !== 0 && Number.isFinite(this.#compensation)
      ? this.#sum + this.#compensation
      : this.#sum;
  }
}
