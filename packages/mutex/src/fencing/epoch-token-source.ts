import { FencingToken } from './fencing-token.ts';
import type { TokenSource } from './token-source.ts';

const SEQUENCE_BITS = 32n;
const EPOCH_LIMIT = 1n << 31n;
const SEQUENCE_LIMIT = 1n << SEQUENCE_BITS;

/**
 * Packs `epoch << 32 | sequence`, so every token minted in a newer epoch beats
 * every token from an older one: a new leader outranks all of its
 * predecessor's grants. The result fits a signed 64-bit integer.
 */
export class EpochTokenSource implements TokenSource {
  readonly #epoch: bigint;
  #sequence = 0n;

  constructor(epoch: bigint) {
    if (epoch < 0n || epoch >= EPOCH_LIMIT) {
      throw new RangeError(`Epoch ${epoch} is outside [0, ${EPOCH_LIMIT}).`);
    }
    this.#epoch = epoch;
  }

  async next(_key: string): Promise<FencingToken> {
    this.#sequence++;
    if (this.#sequence >= SEQUENCE_LIMIT) {
      throw new RangeError(`Epoch ${this.#epoch} has no tokens left.`);
    }
    return new FencingToken((this.#epoch << SEQUENCE_BITS) | this.#sequence);
  }
}
