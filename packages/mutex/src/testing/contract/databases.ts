import assert from 'node:assert/strict';

import { describe, test } from '@zukhruf/parameterized-test';

import { Mutex } from '../../mutex/mutex.ts';
import { hold } from '../hold.ts';
import { uniqueKey } from './keys.ts';
import type { Host, Subject } from './subject.ts';

/** A store whose keys live in one database of a server. */
export function databases<H extends Host>(store: Subject<H>): void {
  describe(`Databases with ${store.name}`, () => {
    test('two stores in different databases on one server do not share a key', async () => {
      // Arrange: two databases on one server, and a holder of the key in the first.
      await using first = await store.fixture(process.env);
      await using second = await store.fixture(process.env);
      await using firstHost = store.open(first.location);
      await using secondHost = store.open(second.location);
      const key = uniqueKey();
      const holder = await hold(new Mutex(firstHost.store), key);
      try {
        // Act
        const other = await secondHost.store.tryAcquire(key);
        await using _lease = other;

        // Assert
        assert.ok(
          other,
          'A key held in one database must be free in another database of the same server',
        );
      } finally {
        await holder.release();
      }
    });
  });
}
