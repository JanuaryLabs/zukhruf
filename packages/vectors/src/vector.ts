import { elements, fromElements } from './elements.ts';
import { ZeroVectorError } from './zero-vector-error.ts';

/** A vector of float32 numbers. */
export class Vector {
  readonly #values: Float32Array;

  protected constructor(values: Float32Array) {
    this.#values = values;
  }

  /** Copies the values. A value that is not finite in float32 is a `RangeError`. */
  static from(values: ArrayLike<number>): Vector {
    return new Vector(finite(Float32Array.from(values), 'float32'));
  }

  static [fromElements](values: Float32Array): Vector {
    return new Vector(finite(values, 'float32'));
  }

  get dimensions(): number {
    return this.#values.length;
  }

  /** A copy of the values. */
  get values(): Float32Array {
    return this.#values.slice();
  }

  get [elements](): Float32Array {
    return this.#values;
  }
}

/** A float32 vector of length 1. The cosine similarity of two unit vectors is their dot product. */
export class UnitVector extends Vector {
  /** Divides each value by the length, in float64. A length of 0 is a `ZeroVectorError`. */
  static normalize(vector: Vector | HalfVector): UnitVector {
    const values = vector[elements];
    let squares = 0;
    for (const value of values) squares += value * value;
    const length = Math.sqrt(squares);
    if (length === 0) throw new ZeroVectorError();
    return new UnitVector(Float32Array.from(values, (value) => value / length));
  }
}

/** A vector of float16 numbers, which SQL Server keeps as `VECTOR(n, float16)`. */
export class HalfVector {
  readonly #values: Float16Array;

  private constructor(values: Float16Array) {
    this.#values = values;
  }

  /** Copies the values. A value that is not finite in float16 is a `RangeError`. */
  static from(values: ArrayLike<number>): HalfVector {
    return new HalfVector(finite(Float16Array.from(values), 'float16'));
  }

  get dimensions(): number {
    return this.#values.length;
  }

  /** A copy of the values. */
  get values(): Float16Array {
    return this.#values.slice();
  }

  get [elements](): Float16Array {
    return this.#values;
  }
}

/** A vector of int8 numbers, which sqlite-vec keeps as `INT8[n]`. */
export class Int8Vector {
  readonly #values: Int8Array;

  private constructor(values: Int8Array) {
    this.#values = values;
  }

  /** Copies the values. A value that is not an integer from -128 to 127 is a `RangeError`. */
  static from(values: ArrayLike<number>): Int8Vector {
    const source = Array.from(values);
    const index = source.findIndex(
      (value) => !Number.isInteger(value) || value < -128 || value > 127,
    );
    if (index !== -1) {
      throw new RangeError(
        `Element ${index} of the vector is not an integer from -128 to 127`,
      );
    }
    return new Int8Vector(Int8Array.from(source));
  }

  static [fromElements](values: Int8Array): Int8Vector {
    return new Int8Vector(values);
  }

  get dimensions(): number {
    return this.#values.length;
  }

  /** A copy of the values. */
  get values(): Int8Array {
    return this.#values.slice();
  }

  get [elements](): Int8Array {
    return this.#values;
  }
}

/**
 * A vector of bits, packed eight to a byte with the least significant bit
 * first, as sqlite-vec packs them. Its dimensions are a multiple of 8.
 */
export class BitVector {
  readonly #bytes: Uint8Array;

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  /** Packs the bits. A number of bits that is not a multiple of 8 is a `RangeError`. */
  static from(bits: ArrayLike<boolean>): BitVector {
    if (bits.length % 8 !== 0) {
      throw new RangeError(
        `A bit vector has a multiple of 8 bits, not ${bits.length}`,
      );
    }
    return new BitVector(
      Uint8Array.from({ length: bits.length / 8 }, (_, byte) => {
        let packed = 0;
        for (let bit = 0; bit < 8; bit++) {
          if (bits[byte * 8 + bit]) packed |= 1 << bit;
        }
        return packed;
      }),
    );
  }

  static [fromElements](bytes: Uint8Array): BitVector {
    return new BitVector(bytes);
  }

  get dimensions(): number {
    return this.#bytes.length * 8;
  }

  /** A copy of the bits, the first bit first. */
  get bits(): boolean[] {
    return Array.from(this.#bytes).flatMap((byte) =>
      Array.from({ length: 8 }, (_, bit) => (byte & (1 << bit)) !== 0),
    );
  }

  get [elements](): Uint8Array {
    return this.#bytes;
  }
}

function finite<T extends Float32Array | Float16Array>(
  values: T,
  type: string,
): T {
  const index = values.findIndex((value) => !Number.isFinite(value));
  if (index !== -1) {
    throw new RangeError(
      `Element ${index} of the vector is not a finite ${type} number`,
    );
  }
  return values;
}
