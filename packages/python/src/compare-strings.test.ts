import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareStrings } from './index.ts';

test('strings sort by code point, as in Python', () => {
  const sorted = ['b', 'a', 'é', '😀', '￿', 'A'].sort(compareStrings);

  assert.deepEqual(sorted, ['A', 'a', 'b', 'é', '￿', '😀']);
});
