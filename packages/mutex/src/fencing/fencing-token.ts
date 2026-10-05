/**
 * Grows with every grant of a lock. A resource that rejects writes carrying a
 * token older than the newest it has seen ignores holders that were superseded
 * without knowing it (frozen, partitioned, or outlived by a failover).
 */
export class FencingToken {
  readonly value: bigint;

  constructor(value: bigint) {
    this.value = value;
  }

  isNewerThan(other: FencingToken): boolean {
    return this.value > other.value;
  }

  toString(): string {
    return this.value.toString();
  }
}
