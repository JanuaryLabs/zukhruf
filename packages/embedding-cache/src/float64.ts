/** The hex of the bytes of each value as a float64, little-endian: each number comes back exactly. */
export function toHex(vector: readonly number[]): string {
  const bytes = new Uint8Array(vector.length * 8);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => view.setFloat64(index * 8, value, true));
  return bytes.toHex();
}

export function fromHex(hex: string): number[] {
  const bytes = Uint8Array.fromHex(hex);
  const view = new DataView(bytes.buffer);
  return Array.from({ length: bytes.byteLength / 8 }, (_, index) =>
    view.getFloat64(index * 8, true),
  );
}
