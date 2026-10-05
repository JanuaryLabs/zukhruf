/** No coordinator is left that could ever grant this key. */
export class CoordinatorUnavailableError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`No lock coordinator is reachable to grant ${JSON.stringify(key)}.`);
    this.name = 'CoordinatorUnavailableError';
    this.key = key;
  }
}
