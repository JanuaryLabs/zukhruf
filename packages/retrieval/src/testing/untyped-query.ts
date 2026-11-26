import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import type { QueryType } from '../index.ts';

/** A retriever as a caller with no types sees it: any value goes in. */
type Untyped = {
  // Method syntax: a retriever of a narrower query type still fits.
  retrieve(query: QueryType): Promise<unknown>;
};

/**
 * A caller with no types may pass a query bundle whose `query` is no string.
 * Each retriever that reads the information need refuses it with a
 * `RangeError` before any call, so no model reads the text of a non-string.
 * `arrange` builds the retriever and the records of every call it must not
 * make; `before` names those calls in the test's name.
 */
export function refusesUntypedQuery(
  before: string,
  arrange: () => {
    readonly retriever: Untyped;
    readonly calls: readonly (readonly unknown[])[];
  },
): void {
  void test.each(
    [
      ['a query bundle with no query', { entrez: 'term' }, 'undefined'],
      ['a query bundle whose query is null', { query: null }, 'null'],
    ] as const,
    ([name, bundle, got]) =>
      test(`${name}, from a caller with no types, is a RangeError before ${before}, so no model reads the text of a non-string`, async () => {
        // Arrange
        const { retriever, calls } = arrange();

        // Act and Assert
        // @ts-expect-error: a caller with no types passes a bundle with no string query
        await assert.rejects(retriever.retrieve(bundle), {
          name: 'RangeError',
          message: `The query of a query bundle is not a string: got ${got}`,
        });
        for (const made of calls) assert.deepEqual(made, []);
      }),
  );
}
