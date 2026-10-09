import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempDisposable,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  CounterTokenSource,
  EpochTokenSource,
  type FencingToken,
  FileTokenSource,
  MonotonicClockTokenSource,
  type TokenSource,
} from './index.ts';

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
        join(tmpdir(), 'zukhruf-fencing-'),
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
      join(tmpdir(), 'zukhruf-fencing-'),
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

  test('a counter file that is not a number fails the mint and stays as it was, so tokens never start again at 1', async () => {
    // Arrange: the counter file of the key holds text that is not a number.
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-fencing-'),
    );
    const path = join(directory.path, 'product%3A42.fence');
    await writeFile(path, 'abc');

    // Act
    const minting = new FileTokenSource(directory.path).next('product:42');

    // Assert
    await assert.rejects(minting);
    assert.equal(await readFile(path, 'utf8'), 'abc');
  });

  test('a FileTokenSource counts each key apart, in its own file', async () => {
    // Arrange
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-fencing-'),
    );
    const tokens = new FileTokenSource(directory.path);
    await tokens.next('product:42');
    await tokens.next('product:42');

    // Act
    const other = await tokens.next('product:43');

    // Assert
    assert.equal(other.value, 1n);
    assert.deepEqual((await readdir(directory.path)).sort(), [
      'product%3A42.fence',
      'product%3A43.fence',
    ]);
  });

  test('a FileTokenSource continues the counter file that an earlier version wrote', async () => {
    // Arrange: published @zukhruf/mutex versions keep the counter as decimal text in <encoded key>.fence.
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-fencing-'),
    );
    await writeFile(join(directory.path, 'product%3A42.fence'), '41');

    // Act
    const token = await new FileTokenSource(directory.path).next('product:42');

    // Assert
    assert.equal(token.value, 42n);
    assert.deepEqual(await readdir(directory.path), ['product%3A42.fence']);
    assert.equal(
      await readFile(join(directory.path, 'product%3A42.fence'), 'utf8'),
      '42',
    );
  });

  test('a FileTokenSource names the file of a long key as earlier versions did', async () => {
    // Arrange: a name has room for 255 characters, less '.fence' and a draft's suffix of 41, so 208 is the longest key kept as is.
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-fencing-'),
    );
    const tokens = new FileTokenSource(directory.path);
    const longest = 'a'.repeat(208);
    const tooLong = 'a'.repeat(209);
    const digest = createHash('sha256')
      .update(Buffer.from(tooLong, 'utf16le'))
      .digest('hex');

    // Act
    await tokens.next(longest);
    await tokens.next(tooLong);

    // Assert
    assert.deepEqual((await readdir(directory.path)).sort(), [
      `${'a'.repeat(32)}%%${digest}.fence`,
      `${longest}.fence`,
    ]);
  });

  test('a new CounterTokenSource and a FileTokenSource with no counter file mint 1 first', async () => {
    // Arrange
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-fencing-'),
    );

    // Act
    const counted = await new CounterTokenSource().next('product:42');
    const filed = await new FileTokenSource(directory.path).next('product:42');

    // Assert
    assert.equal(counted.value, 1n);
    assert.equal(filed.value, 1n);
  });

  test('an EpochTokenSource puts the epoch in the high 32 bits over one sequence for all keys', async () => {
    // Arrange
    const tokens = new EpochTokenSource(5n);

    // Act
    const first = await tokens.next('product:42');
    const second = await tokens.next('product:43');

    // Assert
    assert.equal(first.value, (5n << 32n) | 1n);
    assert.equal(second.value, (5n << 32n) | 2n);
  });

  test('the lowest and the highest epoch mint tokens that fit a signed 64-bit integer', async () => {
    // Arrange
    const lowest = new EpochTokenSource(0n);
    const highest = new EpochTokenSource((1n << 31n) - 1n);

    // Act
    const first = await lowest.next('product:42');
    const last = await highest.next('product:42');

    // Assert
    assert.equal(first.value, 1n);
    assert.equal(last.value, (((1n << 31n) - 1n) << 32n) | 1n);
    assert.ok(last.value < 1n << 63n);
  });
});
