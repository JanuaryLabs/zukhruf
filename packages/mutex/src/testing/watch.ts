export type Settlement<T> =
  | { status: 'pending' }
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

/** Lets a test read whether `promise` has settled, without awaiting it. */
export function watch<T>(promise: Promise<T>): { readonly now: Settlement<T> } {
  let now: Settlement<T> = { status: 'pending' };
  promise.then(
    (value) => {
      now = { status: 'fulfilled', value };
    },
    (reason: unknown) => {
      now = { status: 'rejected', reason };
    },
  );
  return {
    get now() {
      return now;
    },
  };
}
