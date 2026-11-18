import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BitVector,
  DimensionMismatchError,
  HalfVector,
  Int8Vector,
  Vector,
  cosineDistance,
  cosineSimilarity,
  dot,
  euclideanDistance,
  hammingDistance,
  norm,
} from './index.ts';

test('each distance refuses two vectors of other dimensions', () => {
  // Arrange
  const two = Vector.from([1, 2]);
  const three = Vector.from([1, 2, 3]);
  const eight = BitVector.from(Array.from({ length: 8 }, () => true));
  const sixteen = BitVector.from(Array.from({ length: 16 }, () => true));
  const calls: [() => number, number, number][] = [
    [() => dot(two, three), 2, 3],
    [() => cosineSimilarity(two, three), 2, 3],
    [() => cosineDistance(two, three), 2, 3],
    [() => euclideanDistance(two, three), 2, 3],
    [() => hammingDistance(eight, sixteen), 8, 16],
  ];

  for (const [call, expected, actual] of calls) {
    // Act and Assert
    assert.throws(call, (error: unknown) => {
      assert.ok(error instanceof DimensionMismatchError);
      assert.equal(error.expected, expected);
      assert.equal(error.actual, actual);
      return true;
    });
  }
});

test('cosineDistance is 0 for one direction, 1 for orthogonal, 2 for opposite', () => {
  // Arrange
  const x = Vector.from([1, 0]);

  // Act and Assert
  assert.equal(cosineDistance(x, Vector.from([5, 0])), 0);
  assert.equal(cosineDistance(x, Vector.from([0, 3])), 1);
  assert.equal(cosineDistance(x, Vector.from([-2, 0])), 2);
});

test('cosineDistance gives the value of sqlite-vec, and NaN for a zero vector', () => {
  // Arrange: sqlite-vec 0.1.9 gave 0.008539865724742413 for these two vectors.
  const a = Vector.from([1, 2, 3]);
  const b = Vector.from([1, 2, 4]);

  // Act
  const distance = cosineDistance(a, b);

  // Assert
  assert.ok(Math.abs(distance - 0.008539865724742413) < 1e-7, String(distance));
  assert.ok(Number.isNaN(cosineDistance(Vector.from([0, 0, 0]), b)));
});

test('dot, norm, cosineSimilarity, euclideanDistance and hammingDistance give the known values', () => {
  // Arrange
  const a = Vector.from([1, 2, 3]);
  const b = Vector.from([4, 5, 6]);

  // Act and Assert
  assert.equal(dot(a, b), 32);
  assert.equal(norm(Vector.from([3, 4])), 5);
  assert.equal(euclideanDistance(Vector.from([0, 0]), Vector.from([3, 4])), 5);
  assert.ok(Math.abs(cosineSimilarity(a, b) - 32 / Math.sqrt(14 * 77)) < 1e-12);
  assert.ok(
    Math.abs(cosineSimilarity(a, b) - (1 - cosineDistance(a, b))) < 1e-12,
  );
  assert.equal(dot(HalfVector.from([1, 2]), HalfVector.from([3, 4])), 11);
  assert.equal(dot(Int8Vector.from([1, -2]), Int8Vector.from([3, 4])), -5);
  const ones = BitVector.from([
    true,
    true,
    false,
    false,
    true,
    false,
    false,
    false,
  ]);
  const other = BitVector.from([
    true,
    false,
    true,
    false,
    true,
    false,
    false,
    true,
  ]);
  assert.equal(hammingDistance(ones, other), 3);
});
