import { elements } from './elements.ts';
import { HalfVector, Vector } from './vector.ts';

/**
 * The JSON text that SQL Server casts to a vector: each value with 9
 * significant digits for float32 and 5 for float16, the fewest that keep each
 * value. The host casts it: `CAST(@q AS ${sqlType(vector)})`.
 */
export function toSql(vector: Vector | HalfVector): string {
  const digits = vector instanceof HalfVector ? 5 : 9;
  return JSON.stringify(
    Array.from(vector[elements], (value) => Number(value.toPrecision(digits))),
  );
}

/** The type of a `CAST`: `VECTOR(n)` for a `Vector`, `VECTOR(n, float16)` for a `HalfVector`. */
export function sqlType(vector: Vector | HalfVector): string;
/**
 * The type of a column that holds vectors of this type and number of
 * dimensions: `sqlType(HalfVector, 3072)` is `'VECTOR(3072, float16)'`. A
 * number of dimensions that is not a positive integer is a `RangeError`.
 */
export function sqlType(
  type: typeof Vector | typeof HalfVector,
  dimensions: number,
): string;
export function sqlType(
  ...args:
    | [vector: Vector | HalfVector]
    | [type: typeof Vector | typeof HalfVector, dimensions: number]
): string {
  const [half, dimensions] =
    args.length === 1
      ? [args[0] instanceof HalfVector, args[0].dimensions]
      : [args[0] === HalfVector, args[1]];
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new RangeError(
      `A vector has a positive integer number of dimensions, not ${dimensions}`,
    );
  }
  return half ? `VECTOR(${dimensions}, float16)` : `VECTOR(${dimensions})`;
}

/**
 * Reads the JSON text that SQL Server gives for a vector. SQL Server prints
 * float32 values with 8 digits, so a `Vector` can differ from the written one
 * by one unit in the last place; a `HalfVector` gives the written values.
 */
export function fromSql(type: typeof Vector, text: string): Vector;
export function fromSql(type: typeof HalfVector, text: string): HalfVector;
export function fromSql(
  type: typeof Vector | typeof HalfVector,
  text: string,
): Vector | HalfVector {
  const values: unknown = JSON.parse(text);
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    !values.every((value) => typeof value === 'number')
  ) {
    throw new RangeError('The text is not a JSON array of numbers');
  }
  return type === HalfVector ? HalfVector.from(values) : Vector.from(values);
}
