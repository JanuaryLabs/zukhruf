// The value of a vector column, which SQLite gives as a Uint8Array.
export function blob(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array))
    throw new TypeError('A stored vector must be a BLOB.');
  return value;
}
