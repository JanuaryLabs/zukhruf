import { suite as nodeSuite, test as nodeTest } from 'node:test';
import { isPromise } from 'node:util/types';

/**
 * Calls `register` at once for each row, in the order of the table, and
 * waits for every native declaration. The caller calls `test()` or
 * `suite()` itself, so node:test records the caller's file and line (ADR
 * 0003).
 */
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

/** The properties of a function that a bound copy has as its own. */
const OWN = new Set(['length', 'name', 'prototype']);

/**
 * The properties of a node:test function, for a bound copy of it, so `each`
 * goes on the copy and node:test stays unchanged (ADR 0002). Descriptors keep
 * the lazy getters (`mock`, `snapshot`, `assert`) lazy.
 */
function propertiesOf(declaration: object): PropertyDescriptorMap {
  return Object.fromEntries(
    Object.entries(Object.getOwnPropertyDescriptors(declaration)).filter(
      ([key]) => !OWN.has(key),
    ),
  );
}

/** node:test's `suite` with `each`. */
export const suite: typeof nodeSuite & { each: typeof each } = Object.assign(
  Object.defineProperties(nodeSuite.bind(undefined), propertiesOf(nodeSuite)),
  { each },
);

/** node:test's `test` with `each`. */
export const test: typeof nodeTest & { each: typeof each } = Object.assign(
  Object.defineProperties(nodeTest.bind(undefined), propertiesOf(nodeTest)),
  { each },
);

// node:test's `test` names itself `test` and `it`, and its suite `suite` and
// `describe`; on the copy each name gives the copy.
const own = (value: unknown): PropertyDescriptor => ({
  value,
  writable: true,
  enumerable: true,
  configurable: true,
});
Object.defineProperties(test, {
  test: own(test),
  it: own(test),
  suite: own(suite),
  describe: own(suite),
});

export { suite as describe, test as it };
