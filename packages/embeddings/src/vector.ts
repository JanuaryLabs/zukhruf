// A unit vector of float32 values. A dot product of two unit vectors is their
// cosine similarity.
export class UnitVector {
  readonly #values: Float32Array;

  private constructor(values: Float32Array) {
    this.#values = values;
  }

  // Divides each value by the length of the vector.
  static normalize(values: readonly number[]): UnitVector {
    const length = Math.sqrt(
      values.reduce((sum, value) => sum + value * value, 0),
    );
    if (length === 0 || !Number.isFinite(length))
      throw new RangeError(
        `An embedding must have a finite length that is not zero. Its length is ${length}.`,
      );
    return new UnitVector(Float32Array.from(values, (value) => value / length));
  }

  // The bytes that SQLite gives are copied, because a Float32Array needs an
  // offset that is a multiple of 4.
  static fromBlob(blob: Uint8Array): UnitVector {
    return new UnitVector(new Float32Array(Uint8Array.from(blob).buffer));
  }

  get dimension(): number {
    return this.#values.length;
  }

  toBlob(): Uint8Array {
    return new Uint8Array(
      this.#values.buffer,
      this.#values.byteOffset,
      this.#values.byteLength,
    );
  }

  cosine(other: UnitVector): number {
    let sum = 0;
    for (const [index, value] of this.#values.entries())
      sum += value * (other.#values[index] ?? 0);
    return sum;
  }
}
