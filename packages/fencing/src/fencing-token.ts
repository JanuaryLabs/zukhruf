/**
 * Grows with every grant. A resource that rejects writes carrying a token
 * older than the newest it has seen ignores holders that were superseded
 * without knowing it (frozen, partitioned, or outlived by a failover).
 */
export class FencingToken {
  readonly value: bigint;

  constructor(value: bigint) {
    this.value = value;
  }

  /**
   * Reads decimal digits, the text that `toString` writes, or returns null for
   * any other text. `BigInt` alone would also accept `''`, `' 1'` and `'0x10'`,
   * and a token is never negative.
   */
  static parse(text: string): FencingToken | null {
    return /^\d+$/.test(text) ? new FencingToken(BigInt(text)) : null;
  }

  isNewerThan(other: FencingToken): boolean {
    return this.value > other.value;
  }

  toString(): string {
    return this.value.toString();
  }
}
