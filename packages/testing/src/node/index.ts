import { suite as nodeSuite, test as nodeTest } from 'node:test';
import { isPromise } from 'node:util/types';

/** Calls register synchronously for each row and waits for every native declaration. */
function each<Row>(
  rows: readonly Row[],
  register: (row: Row, index: number) => Promise<void>,
): Promise<void> {
  if (rows.length === 0) throw new Error('each() requires at least one case');
  return Promise.all(
    rows.map((row, index) => {
      const registration = register(row, index);
      if (!isPromise(registration)) {
        throw new TypeError('each() callback must return test() or suite()');
      }
      return registration;
    }),
  ).then(() => undefined);
}

/** Return a native test() call from the callback to preserve its declaration location. */
export const test = Object.assign(nodeTest, { each });
/** Return a native suite() call from the callback; acquire resources inside its tests. */
export const suite = Object.assign(nodeSuite, { each });
export { suite as describe, test as it };
