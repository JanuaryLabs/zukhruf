import assert from 'node:assert/strict';

import { describe, test } from '@zukhruf/testing/node';

import { Mutex } from '../../mutex/mutex.ts';
import type { Host, Subject } from './subject.ts';

/** Every lock store: looks with isHeld. */
export function holderCheck<H extends Host>(store: Subject<H>): void {
  describe(`Holder check with ${store.name}`, () => {
    test('a key reads as held only while a task holds it', async () => {
      // Arrange
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);

      // Act
      const before = await mutex.isHeld('report:daily');
      const during = await mutex.acquire('report:daily', () =>
        mutex.isHeld('report:daily'),
      );
      const after = await mutex.isHeld('report:daily');

      // Assert
      assert.deepEqual(
        { before, during, after },
        { before: false, during: true, after: false },
      );
    });

    test('a key answers for its own name, not for another key', async () => {
      // Arrange
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const daily = mutex.key('report:daily');
      const weekly = mutex.key('report:weekly');

      // Act
      const seen = await daily.run(async () => ({
        daily: await daily.isHeld(),
        weekly: await weekly.isHeld(),
      }));

      // Assert
      assert.deepEqual(seen, { daily: true, weekly: false });
    });
  });
}

/** A store whose next token is the last + 1: a look mints none. */
export function looksTakeNoToken<H extends Host>(store: Subject<H>): void {
  describe(`Holder check with ${store.name}`, () => {
    test('looks take no fencing token', async () => {
      // Arrange
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const lookTwenty = async () => {
        for (let look = 0; look < 20; look++) {
          await mutex.isHeld('report:daily');
        }
      };

      // Act: look while the key is held, then while it is free, between two grants.
      const held = await mutex.acquire('report:daily', async ({ token }) => {
        await lookTwenty();
        return token;
      });
      await lookTwenty();
      const next = await mutex.acquire(
        'report:daily',
        async ({ token }) => token,
      );

      // Assert
      assert.equal(
        next.value,
        held.value + 1n,
        'Looks between two grants must take no token',
      );
    });
  });
}
