import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Backoff, type BackoffOptions } from './index.ts';

describe('Backoff', () => {
  test('options that describe no back-off throw a RangeError when the back-off is made', () => {
    // Arrange
    const valid: BackoffOptions = {
      initial: 100,
      multiplier: 2,
      max: 1_000,
      jitter: { kind: 'none' },
    };
    const invalid: BackoffOptions[] = [
      { ...valid, initial: 0 },
      { ...valid, initial: -1 },
      { ...valid, initial: Number.NaN },
      { ...valid, initial: Infinity },
      { ...valid, multiplier: 0.5 },
      { ...valid, multiplier: Number.NaN },
      { ...valid, multiplier: Infinity },
      { ...valid, max: 99 },
      { ...valid, max: Infinity },
      { ...valid, max: Number.NaN },
      { ...valid, jitter: { kind: 'ratio', ratio: 0 } },
      { ...valid, jitter: { kind: 'ratio', ratio: -0.1 } },
      { ...valid, jitter: { kind: 'ratio', ratio: 1.5 } },
      { ...valid, jitter: { kind: 'ratio', ratio: Number.NaN } },
    ];

    // Act and Assert
    for (const options of invalid) {
      assert.throws(
        () => new Backoff(options),
        RangeError,
        `Must refuse ${JSON.stringify(options)}`,
      );
    }
  });

  test('the edge of each option makes a back-off: a multiplier of 1 gives the same wait each time, a max equal to initial, and a ratio of 1', () => {
    // Arrange
    const constant = new Backoff({
      initial: 100,
      multiplier: 1,
      max: 100,
      jitter: { kind: 'ratio', ratio: 1 },
      random: () => 0.5,
    });

    // Act
    const waits = [0, 1, 2, 10].map((retries) => constant.duration(retries));

    // Assert
    assert.deepEqual(waits, [100, 100, 100, 100]);
  });

  test('a count of retries that is not an integer of 0 or more throws a RangeError', () => {
    // Arrange
    const backoff = new Backoff({
      initial: 100,
      multiplier: 2,
      max: 1_000,
      jitter: { kind: 'none' },
    });

    // Act and Assert
    for (const retries of [-1, 1.5, Number.NaN, Infinity]) {
      assert.throws(
        () => backoff.duration(retries),
        RangeError,
        `Must refuse ${retries} retries`,
      );
    }
  });

  test('without jitter, the wait grows by the multiplier from initial before the first retry, and stops at max', () => {
    // Arrange: the first back-off has the numbers that patiently of @zukhruf/fs uses.
    const doubling = new Backoff({
      initial: 5,
      multiplier: 2,
      max: 100,
      jitter: { kind: 'none' },
    });
    const halfAgain = new Backoff({
      initial: 1_000,
      multiplier: 1.5,
      max: 10_000,
      jitter: { kind: 'none' },
    });

    // Act
    const doublingWaits = [0, 1, 2, 3, 4, 5, 6].map((retries) =>
      doubling.duration(retries),
    );
    const halfAgainWaits = [0, 1, 2, 3].map((retries) =>
      halfAgain.duration(retries),
    );

    // Assert
    assert.deepEqual(doublingWaits, [5, 10, 20, 40, 80, 100, 100]);
    assert.deepEqual(halfAgainWaits, [1_000, 1_500, 2_250, 3_375]);
  });

  test('a ratio jitter gives the wait plus or minus the ratio of it, also above max, and no jitter before the first retry', () => {
    // Arrange: with no jitter the waits are 1000, 2000, 4000, and max is 4000.
    const withRandom = (value: number) =>
      new Backoff({
        initial: 1_000,
        multiplier: 2,
        max: 4_000,
        jitter: { kind: 'ratio', ratio: 0.25 },
        random: () => value,
      });

    // Act
    const first = [0, 0.875].map((value) => withRandom(value).duration(0));
    const second = [0, 0.5, 0.875].map((value) =>
      withRandom(value).duration(1),
    );
    const capped = [0, 0.875].map((value) => withRandom(value).duration(5));

    // Assert
    assert.deepEqual(first, [1_000, 1_000], 'The first wait has no jitter');
    assert.deepEqual(second, [1_500, 2_000, 2_375]);
    assert.deepEqual(capped, [3_000, 4_750], 'The jitter applies after max');
  });

  test('a full jitter gives a wait from 0 to the wait without jitter, within max', () => {
    // Arrange: with no jitter the waits are 1000, 2000, 4000, and max is 4000.
    const withRandom = (value: number) =>
      new Backoff({
        initial: 1_000,
        multiplier: 2,
        max: 4_000,
        jitter: { kind: 'full' },
        random: () => value,
      });

    // Act
    const half = [0, 1, 2, 5].map((retries) =>
      withRandom(0.5).duration(retries),
    );
    const none = withRandom(0).duration(1);

    // Assert
    assert.deepEqual(half, [500, 1_000, 2_000, 2_000]);
    assert.equal(none, 0);
  });

  test('an equal jitter gives a wait from half of the wait without jitter to all of it, within max', () => {
    // Arrange: with no jitter the waits are 1000, 2000, 4000, and max is 4000.
    const withRandom = (value: number) =>
      new Backoff({
        initial: 1_000,
        multiplier: 2,
        max: 4_000,
        jitter: { kind: 'equal' },
        random: () => value,
      });

    // Act
    const half = [0, 1, 2, 5].map((retries) =>
      withRandom(0.5).duration(retries),
    );
    const least = withRandom(0).duration(1);

    // Assert
    assert.deepEqual(half, [750, 1_500, 3_000, 3_000]);
    assert.equal(least, 1_000);
  });

  test('without a random source, the waits of a full jitter are random, from 0 to the wait without jitter', () => {
    // Arrange
    const backoff = new Backoff({
      initial: 1_000,
      multiplier: 1,
      max: 1_000,
      jitter: { kind: 'full' },
    });

    // Act
    const waits = Array.from({ length: 100 }, () => backoff.duration(3));

    // Assert
    assert.ok(
      waits.every((wait) => wait >= 0 && wait < 1_000),
      `Each wait must be in [0, 1000), not ${waits.join(', ')}`,
    );
    assert.ok(new Set(waits).size > 1, 'The waits must differ');
  });

  test('the wait depends only on the count of retries, not on the calls before it', () => {
    // Arrange
    const backoff = new Backoff({
      initial: 1_000,
      multiplier: 2,
      max: 60_000,
      jitter: { kind: 'equal' },
      random: () => 0.5,
    });

    // Act
    const waits = [3, 0, 3, 1, 1].map((retries) => backoff.duration(retries));

    // Assert
    assert.deepEqual(waits, [6_000, 750, 6_000, 1_500, 1_500]);
  });
});
