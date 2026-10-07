/** The key may have been granted to another holder while its lease was still in use. */
export class LockLostError extends Error {
  readonly key: string;

  constructor(key: string, options?: ErrorOptions) {
    super(
      `Lost the lock on ${JSON.stringify(key)}: another holder may have been granted it.`,
      options,
    );
    this.name = 'LockLostError';
    this.key = key;
  }
}
