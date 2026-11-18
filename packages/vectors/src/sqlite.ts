import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { elements, fromElements } from './elements.ts';
import { SqliteVecLoadedError } from './sqlite-vec-loaded-error.ts';
import { BitVector, Int8Vector, Vector } from './vector.ts';

export { SqliteVecLoadedError } from './sqlite-vec-loaded-error.ts';

/**
 * Registers `vec_distance_cosine` and `vec_distance_L2` of sqlite-vec 0.1.9 on
 * a database that does not load the extension, with its results (to float32
 * precision), its `NULL` and its error texts, so one SQL runs with or without
 * sqlite-vec. See docs/ported-from-sqlite-vec.md.
 */
export function install(database: DatabaseSync): void {
  if (hasSqliteVec(database)) throw new SqliteVecLoadedError();
  const options = { deterministic: true, useBigIntArguments: true };
  database.function('vec_distance_cosine', options, (a, b) => {
    const [x, y] = vectors(a, b);
    let dot = 0;
    let squaresX = 0;
    let squaresY = 0;
    x.forEach((value, index) => {
      const other = y[index] ?? 0;
      dot += value * other;
      squaresX += value * value;
      squaresY += other * other;
    });
    // A zero vector gives NaN, which SQLite returns as NULL, as sqlite-vec does.
    return 1 - dot / (Math.sqrt(squaresX) * Math.sqrt(squaresY));
  });
  database.function('vec_distance_L2', options, (a, b) => {
    const [x, y] = vectors(a, b);
    let squares = 0;
    x.forEach((value, index) => {
      const difference = value - (y[index] ?? 0);
      squares += difference * difference;
    });
    return Math.sqrt(squares);
  });
}

function hasSqliteVec(database: DatabaseSync): boolean {
  try {
    database.prepare('SELECT vec_version()');
    return true;
  } catch (error) {
    if (
      Error.isError(error) &&
      error.message === 'no such function: vec_version'
    ) {
      return false;
    }
    throw error;
  }
}

function vectors(
  a: SQLInputValue,
  b: SQLInputValue,
): [Float32Array, Float32Array] {
  const x = vector(a, '1st');
  const y = vector(b, '2nd');
  if (x.length !== y.length) {
    throw new Error(
      `Vector dimension mistmatch. First vector has ${x.length} dimensions, while the second has ${y.length} dimensions.`,
    );
  }
  return [x, y];
}

function vector(value: SQLInputValue, ordinal: '1st' | '2nd'): Float32Array {
  const reading = `Error reading ${ordinal} vector:`;
  if (value instanceof Uint8Array) {
    if (value.length === 0) {
      throw new Error(`${reading} zero-length vectors are not supported.`);
    }
    if (value.length % 4 !== 0) {
      throw new Error(
        `${reading} invalid float32 vector BLOB length. Must be divisible by 4, found ${value.length}`,
      );
    }
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    return Float32Array.from({ length: value.length / 4 }, (_, index) =>
      view.getFloat32(index * 4, true),
    );
  }
  if (typeof value === 'string') {
    const parsed = json(value);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((item) => typeof item === 'number')
    ) {
      throw new Error(`${reading} the text is not a JSON array of numbers.`);
    }
    if (parsed.length === 0) {
      throw new Error(`${reading} zero-length vectors are not supported.`);
    }
    return Float32Array.from(parsed);
  }
  const type =
    value === null ? 'NULL' : typeof value === 'bigint' ? 'INTEGER' : 'FLOAT';
  throw new Error(
    `${reading} Input must have type BLOB (compact format) or TEXT (JSON), found ${type}`,
  );
}

// sqlite-vec reads some malformed JSON (`[1,` as `[1]`); this port refuses it.
function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * The bytes that plain SQLite and sqlite-vec read: float32 values
 * little-endian, int8 values as bytes, and bits packed least significant bit
 * first, as sqlite-vec packs them.
 */
export function toSql(vector: Vector | Int8Vector | BitVector): Uint8Array {
  if (vector instanceof Vector) {
    const values = vector[elements];
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setFloat32(index * 4, value, true));
    return bytes;
  }
  const values = vector[elements];
  return new Uint8Array(
    values.buffer,
    values.byteOffset,
    values.byteLength,
  ).slice();
}

/** Reads the bytes of `toSql` as a vector of the type. A BLOB whose length does not fit the type is a `RangeError`. */
export function fromSql(type: typeof Vector, blob: Uint8Array): Vector;
export function fromSql(type: typeof Int8Vector, blob: Uint8Array): Int8Vector;
export function fromSql(type: typeof BitVector, blob: Uint8Array): BitVector;
export function fromSql(
  type: typeof Vector | typeof Int8Vector | typeof BitVector,
  blob: Uint8Array,
): Vector | Int8Vector | BitVector {
  if (blob.length === 0) {
    throw new RangeError('A vector BLOB has at least one byte');
  }
  if (type === Int8Vector) {
    return Int8Vector[fromElements](new Int8Array(blob.slice().buffer));
  }
  if (type === BitVector) {
    return BitVector[fromElements](blob.slice());
  }
  if (blob.length % 4 !== 0) {
    throw new RangeError(
      `A float32 vector BLOB has a multiple of 4 bytes, not ${blob.length}`,
    );
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  return Vector[fromElements](
    Float32Array.from({ length: blob.length / 4 }, (_, index) =>
      view.getFloat32(index * 4, true),
    ),
  );
}
