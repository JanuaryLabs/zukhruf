import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LabelCase,
  LabelComparer,
  LabelConfigCase,
  LabelVarsCase,
} from './index.ts';

const stated = (answer: unknown, expected: number | string | string[]) => [
  ...new LabelComparer().compare(answer, new LabelCase({ expected, weight: 1 }))
    .stated,
];

test('LabelComparer reads a JSON array of labels in the text as a set of labels, and other text as one label without its outer white space', () => {
  assert.deepEqual(stated(' ["pos", "neg", "pos"] ', ['pos']), ['pos', 'neg']);
  assert.deepEqual(stated('  pos\n', 'pos'), ['pos']);
  assert.deepEqual(stated('[not json', 'pos'), ['[not json']);
  assert.deepEqual(stated('[{"a": 1}]', 'pos'), ['[{"a": 1}]']);
  assert.deepEqual(stated(['a', 'b'], 'a'), ['a', 'b']);
});

test('LabelComparer reads a number in the text as a number only when each expected label of the case is a number, so "7" matches the label 7 and the label "7"', () => {
  assert.deepEqual(stated(' 7 ', 7), [7]);
  assert.deepEqual(stated('7', '7'), ['7']);
  assert.deepEqual(stated(7, '7'), [7]);
});

test('LabelComparer refuses a stated answer that is not a label, a list of labels or text', () => {
  assert.throws(
    () => stated({ label: 'pos' }, 'pos'),
    /A stated answer is a label, a list of labels or text/,
  );
});

test('LabelVarsCase reads vars.expected and vars.weight, and LabelConfigCase reads config.expected with the weight 1; both refuse an expected value that is not a label or a list of labels', () => {
  const vars = new LabelVarsCase().from({ expected: ['a', 'b'], weight: 3 });
  const config = new LabelConfigCase().from({ expected: 2, weight: 3 });

  assert.deepEqual([[...vars.expected], vars.weight], [['a', 'b'], 3]);
  assert.equal(new LabelVarsCase().from({ expected: 'a' }).weight, 1);
  assert.deepEqual([[...config.expected], config.weight], [[2], 1]);
  assert.throws(
    () => new LabelVarsCase().from({ expected: { a: 1 } }),
    /vars\.expected is a label \(a number or a string\) or a list of labels/,
  );
  assert.throws(
    () => new LabelConfigCase().from({}),
    /config\.expected is a label/,
  );
  assert.throws(
    () => new LabelVarsCase().from({ expected: 'a', weight: 'heavy' }),
    /vars\.weight is a number, not "heavy"/,
  );
});
