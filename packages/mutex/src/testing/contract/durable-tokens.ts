import assert from 'node:assert/strict';

import type { FencingToken } from '@zukhruf/fencing';
import { describe, test } from '@zukhruf/testing/node';

import { Mutex } from '../../mutex/mutex.ts';
import { label, longKey } from './keys.ts';
import type { Host, Subject } from './subject.ts';

/** A store whose fixture keeps its token counter: a new store over it keeps issuing newer tokens. */
export function durableTokens<H extends Host>(store: Subject<H>): void {
  describe(`Single-process mutex with ${store.name}`, () => {
    void test.each(['product:42', longKey], (key) =>
      test(`a new store over the same fixture keeps issuing newer tokens for resource name ${label(key)}`, async () => {
        // Arrange: one store instance holds the key once, then goes away (e.g. a restart).
        await using fixture = await store.fixture(process.env);
        let before: FencingToken;
        {
          await using previous = store.open(fixture.location);
          before = await new Mutex(previous.store).acquire(
            key,
            async (lease) => lease.token,
          );
        }

        // Act: a fresh instance over the same fixture holds the key again.
        await using restarted = store.open(fixture.location);
        const after = await new Mutex(restarted.store).acquire(
          key,
          async (lease) => lease.token,
        );

        // Assert: the restart did not reset the token sequence.
        assert.ok(
          after.isNewerThan(before),
          `The token after a restart (${after}) must be newer than before it (${before})`,
        );
      }),
    );
  });
}
