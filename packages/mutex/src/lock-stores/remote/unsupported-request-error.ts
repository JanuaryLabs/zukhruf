/** The lock coordinator runs an older version of the package, which does not answer this request. */
export class UnsupportedRequestError extends Error {
  readonly op: string;
  readonly key: string;

  constructor(op: string, key: string) {
    super(
      `The lock coordinator does not answer '${op}' for ${JSON.stringify(key)}: it runs an older version of @zukhruf/mutex. Upgrade every process that shares these locks.`,
    );
    this.name = 'UnsupportedRequestError';
    this.op = op;
    this.key = key;
  }
}
