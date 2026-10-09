import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { FencingToken } from '@zukhruf/fencing';

import { FencedStock } from './fenced-stock.ts';

async function stockOf(quantity: number) {
  const directory = await mkdtempDisposable(
    join(tmpdir(), 'fenced-stock-test-'),
  );
  const stock = new FencedStock(join(directory.path, 'inventory.db'));
  stock.restock('product:42', quantity);
  return {
    stock,
    [Symbol.asyncDispose]: async () => {
      stock.close();
      await directory.remove();
    },
  };
}

describe('Fenced stock', () => {
  test('a holder that was superseded cannot reserve after the newer holder did', async () => {
    // Arrange: the newer holder (token 34) reserves first.
    await using fixture = await stockOf(2);
    assert.equal(
      fixture.stock.reserve('product:42', new FencingToken(34n)),
      'reserved',
    );

    // Act: the superseded holder (token 33) wakes up and tries to reserve.
    const late = fixture.stock.reserve('product:42', new FencingToken(33n));

    // Assert: the stale write is refused and the stock is untouched by it.
    assert.equal(late, 'stale', 'An older token must be refused as stale');
    assert.equal(
      fixture.stock.quantity('product:42'),
      1,
      'Only the newer holder may consume stock',
    );
  });

  test('one holder can reserve several items with the same token', async () => {
    // Arrange
    await using fixture = await stockOf(2);
    const token = new FencingToken(7n);

    // Act
    const outcomes = [
      fixture.stock.reserve('product:42', token),
      fixture.stock.reserve('product:42', token),
    ];

    // Assert: a current holder is never fenced off by its own token.
    assert.deepEqual(outcomes, ['reserved', 'reserved']);
    assert.equal(fixture.stock.quantity('product:42'), 0);
  });

  test('running out of stock is reported apart from a stale token', async () => {
    // Arrange
    await using fixture = await stockOf(1);
    fixture.stock.reserve('product:42', new FencingToken(1n));

    // Act: a newer holder arrives after the last item is gone.
    const outcome = fixture.stock.reserve('product:42', new FencingToken(2n));

    // Assert
    assert.equal(
      outcome,
      'sold-out',
      'A current holder facing no stock must see sold-out, not stale',
    );
  });

  test('an unknown product is sold out', async () => {
    await using fixture = await stockOf(1);
    assert.equal(
      fixture.stock.reserve('product:99', new FencingToken(1n)),
      'sold-out',
    );
  });
});
