import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { waitUntil } from '../testing/wait-until.ts';
import { watch } from '../testing/watch.ts';
import { Latch } from './latch.ts';

describe('Latch', () => {
  test('a wait ends only when the latch opens', async (t) => {
    // Arrange
    const latch = new Latch();
    const waiting = watch(latch.wait());
    await delay(10);
    const beforeOpen = waiting.now.status;

    // Act
    latch.open();

    // Assert
    assert.equal(beforeOpen, 'pending', 'A closed latch must hold its waiters');
    await waitUntil(
      t,
      () => waiting.now.status === 'fulfilled',
      'The wait must end when the latch opens',
    );
  });

  test('a wait that starts after the latch opened ends at once, also after a second open', async (t) => {
    // Arrange
    const latch = new Latch();
    latch.open();

    // Act
    latch.open();
    const waiting = watch(latch.wait());

    // Assert
    await waitUntil(
      t,
      () => waiting.now.status === 'fulfilled',
      'An open latch must stay open',
    );
  });
});
