import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import {
  BitVector,
  HalfVector,
  Int8Vector,
  UnitVector,
  Vector,
  ZeroVectorError,
} from './index.ts';

void test.each(
  [[1, Number.NaN], [Number.POSITIVE_INFINITY], [1e39]],
  (source) =>
    test(`Vector.from refuses a value that is not finite in float32: [${String(source)}]`, () => {
      // Act and Assert
      assert.throws(() => Vector.from(source), RangeError, String(source));
    }),
);

// 70000 is past the largest float16, 65504.
void test.each([[Number.NaN], [Number.NEGATIVE_INFINITY], [70000]], (source) =>
  test(`HalfVector.from refuses a value that is not finite in float16: [${String(source)}]`, () => {
    // Act and Assert
    assert.throws(() => HalfVector.from(source), RangeError, String(source));
  }),
);

void test.each([[128], [-129], [1.5], [Number.NaN]], (source) =>
  test(`Int8Vector.from refuses a value that is not an integer from -128 to 127: [${String(source)}]`, () => {
    // Act and Assert
    assert.throws(() => Int8Vector.from(source), RangeError, String(source));
  }),
);

test('Int8Vector.from keeps the edges of the range', () => {
  // Act
  const vector = Int8Vector.from([-128, 0, 127]);

  // Assert
  assert.deepEqual([...vector.values], [-128, 0, 127]);
});

test('BitVector.from refuses a number of bits that is not a multiple of 8', () => {
  // Arrange
  const bits = Array.from({ length: 10 }, () => true);

  // Act and Assert
  assert.throws(() => BitVector.from(bits), RangeError);
});

test('BitVector.from keeps each bit, and its dimensions are the number of bits', () => {
  // Arrange
  const bits = [
    true,
    false,
    false,
    true,
    false,
    false,
    false,
    false,
    true,
    true,
    true,
    true,
    false,
    false,
    false,
    false,
  ];

  // Act
  const vector = BitVector.from(bits);

  // Assert
  assert.equal(vector.dimensions, 16);
  assert.deepEqual([...vector.bits], bits);
});

test('UnitVector.normalize refuses a vector of length 0 with a ZeroVectorError, which is a RangeError', () => {
  // Arrange
  const zero = Vector.from([0, 0, 0]);

  // Act and Assert: a host that catches RangeError for an invalid value catches this one too.
  assert.throws(() => UnitVector.normalize(zero), ZeroVectorError);
  assert.throws(() => UnitVector.normalize(zero), RangeError);
});

void test.each(
  [
    { name: 'Vector', create: () => Vector.from([3, 4]) },
    { name: 'HalfVector', create: () => HalfVector.from([3, 4]) },
  ],
  ({ name, create }) =>
    test(`UnitVector.normalize gives a vector of length 1 in the same direction for a ${name}`, () => {
      // Arrange
      const vector = create();

      // Act
      const unit = UnitVector.normalize(vector);

      // Assert
      assert.ok(unit instanceof Vector);
      assert.deepEqual(
        [...unit.values],
        [0.6000000238418579, 0.800000011920929],
      );
    }),
);

test('each from copies its source, and values gives a copy', () => {
  // Arrange
  const float32 = new Float32Array([1, 2]);
  const float16 = new Float16Array([1, 2]);
  const int8 = new Int8Array([1, 2]);
  const bits = [true, false, false, false, false, false, false, false];
  const vector = Vector.from(float32);
  const half = HalfVector.from(float16);
  const small = Int8Vector.from(int8);
  const bitVector = BitVector.from(bits);

  // Act
  float32[0] = 9;
  float16[0] = 9;
  int8[0] = 9;
  bits[0] = false;
  vector.values[1] = 9;
  half.values[1] = 9;
  small.values[1] = 9;
  bitVector.bits[1] = true;

  // Assert
  assert.deepEqual([...vector.values], [1, 2]);
  assert.deepEqual([...half.values], [1, 2]);
  assert.deepEqual([...small.values], [1, 2]);
  assert.deepEqual(bitVector.bits, [
    true,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
  ]);
});
