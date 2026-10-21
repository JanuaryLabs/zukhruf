/** The term of this epoch gave all of its tokens. Only a new term, with a higher epoch, can give more tokens. */
export class EpochExhaustedError extends RangeError {
  readonly epoch: bigint;

  constructor(epoch: bigint) {
    super(`Epoch ${epoch} has no tokens left.`);
    this.name = 'EpochExhaustedError';
    this.epoch = epoch;
  }
}
