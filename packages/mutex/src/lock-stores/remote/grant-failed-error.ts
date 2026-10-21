/** The lock coordinator could not grant the key, because it could not mint a fencing token for it. The key is not held. */
export class GrantFailedError extends Error {
  readonly key: string;

  constructor(key: string, reason: string) {
    super(
      `The lock coordinator could not grant ${JSON.stringify(key)}: ${reason}`,
    );
    this.name = 'GrantFailedError';
    this.key = key;
  }
}
