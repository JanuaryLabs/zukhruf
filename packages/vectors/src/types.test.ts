import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BitVector,
  HalfVector,
  Int8Vector,
  Vector,
  dot,
  hammingDistance,
} from './index.ts';
import * as sqlite from './sqlite.ts';
import * as sqlserver from './sqlserver.ts';

// `nx run vectors:typecheck` proves each line under `@ts-expect-error`: it
// fails when such a line compiles. The function never runs.
function refusedByTheTypes(): void {
  // @ts-expect-error SQL Server stores no int8 vector.
  sqlserver.toSql(Int8Vector.from([1]));
  const bits = BitVector.from([
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    true,
  ]);
  // @ts-expect-error SQL Server stores no bit vector.
  sqlserver.sqlType(bits);
  // @ts-expect-error SQL Server gives back no int8 vector.
  sqlserver.fromSql(Int8Vector, '[1]');
  // @ts-expect-error SQLite has no float16 vector.
  sqlite.toSql(HalfVector.from([1]));
  // @ts-expect-error A distance compares two vectors of one element type.
  dot(Vector.from([1]), HalfVector.from([1]));
  // @ts-expect-error Hamming compares bit vectors only.
  hammingDistance(Vector.from([1]), Vector.from([1]));
}

test('the types refuse each vector that an engine or a distance does not take', () => {
  // Assert: the claims are the @ts-expect-error lines above, which the typecheck target proves.
  assert.equal(typeof refusedByTheTypes, 'function');
});
