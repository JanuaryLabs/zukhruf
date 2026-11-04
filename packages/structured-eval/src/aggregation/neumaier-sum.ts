// A running sum with Neumaier's compensated summation (Neumaier 1974), the
// algorithm of the sum() of CPython 3.12 for floats, so a sum here equals
// Python's to the last bit. Copied from @zukhruf/mteb pythonSum
// (docs/copied-code.md).
export class NeumaierSum {
  #sum = 0;
  #compensation = 0;

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
