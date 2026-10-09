import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { CounterTokenSource } from './counter-token-source.ts';
import { EpochTokenSource } from './epoch-token-source.ts';
import type { FencingToken } from './fencing-token.ts';
import { FileTokenSource } from './file-token-source.ts';
import { MonotonicClockTokenSource } from './monotonic-clock-token-source.ts';
import type { TokenSource } from './token-source.ts';

const sources: Array<{
  name: string;
  create(directory: string): TokenSource;
  tokens: number;
}> = [
  {
    name: 'CounterTokenSource',
    create: () => new CounterTokenSource(),
    tokens: 1000,
  },
  {
    name: 'FileTokenSource',
    create: (directory) => new FileTokenSource(directory),
    // Each token waits for the disk, up to 60 ms on a busy Windows runner; 101 cross the counter's 10 and 100.
    tokens: 101,
  },
  {
    name: 'MonotonicClockTokenSource',
    create: () => new MonotonicClockTokenSource(),
    tokens: 1000,
  },
  {
    name: 'EpochTokenSource',
    create: () => new EpochTokenSource(7n),
    tokens: 1000,
  },
];

describe('Token sources', () => {
  for (const source of sources) {
    test(`${source.name} mints strictly newer tokens for a key`, async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'fencing-test-'),
      );
      const tokens = source.create(directory.path);
      const minted: FencingToken[] = [];

      // Act
      for (let i = 0; i < source.tokens; i++)
        minted.push(await tokens.next('product:42'));

      // Assert
      assert.ok(
        minted.every(
          (token, index) =>
            index === 0 || token.isNewerThan(minted[index - 1]!),
        ),
        'Every token must be newer than the one minted before it',
      );
    });
  }

  test('a FileTokenSource over the same directory continues above the previous maximum', async () => {
    // Arrange: a previous process minted tokens, then exited.
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'fencing-test-'),
    );
    const previous = new FileTokenSource(directory.path);
    await previous.next('product:42');
    const last = await previous.next('product:42');

    // Act: a new process starts over the same directory.
    const next = await new FileTokenSource(directory.path).next('product:42');

    // Assert
    assert.ok(
      next.isNewerThan(last),
      `The restarted source minted ${next}, which must be newer than ${last}`,
    );
  });

  test('every token from a newer epoch beats every token from an older epoch', async () => {
    // Arrange: the old leader has minted many tokens.
    const oldLeader = new EpochTokenSource(3n);
    let oldest = await oldLeader.next('product:42');
    for (let i = 0; i < 10_000; i++)
      oldest = await oldLeader.next('product:42');

    // Act: the next leader mints its first token.
    const first = await new EpochTokenSource(4n).next('product:42');

    // Assert
    assert.ok(
      first.isNewerThan(oldest),
      `The new epoch's first token (${first}) must beat the old epoch's latest (${oldest})`,
    );
  });

  test('an epoch beyond the signed 64-bit token range is rejected', () => {
    assert.throws(() => new EpochTokenSource(1n << 31n), RangeError);
    assert.throws(() => new EpochTokenSource(-1n), RangeError);
  });
});
