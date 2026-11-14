import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalJson } from './canonical-json.ts';

// The samples of RFC 8785 (https://www.rfc-editor.org/rfc/rfc8785), and the
// structures test of its test data
// (https://github.com/cyberphone/json-canonicalization/tree/master/testdata).

test('canonicalJson writes the sample of RFC 8785, section 3.2.3: the keys sorted, no white space, and the numbers and strings as ECMAScript writes them', () => {
  const parsed: unknown = JSON.parse(
    '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],' +
      '"string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
      '"literals": [null, true, false]}',
  );

  assert.equal(
    canonicalJson(parsed),
    '{"literals":[null,true,false],' +
      '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
      '"string":"\u{20ac}$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
  );
});

test('canonicalJson sorts the keys by their UTF-16 code units, in the order that the sorting test of RFC 8785, section 3.2.3, expects', () => {
  const text = canonicalJson({
    '\u{20ac}': 'Euro Sign',
    '\r': 'Carriage Return',
    '\u{fb33}': 'Hebrew Letter Dalet With Dagesh',
    '1': 'One',
    '\u{1f600}': 'Emoji: Grinning Face',
    '\u{80}': 'Control',
    '\u{f6}': 'Latin Small Letter O With Diaeresis',
  });

  assert.deepEqual(
    [...text.matchAll(/:"(?<value>[^"]*)"/gu)].map(
      (match) => match.groups?.['value'],
    ),
    [
      'Carriage Return',
      'One',
      'Control',
      'Latin Small Letter O With Diaeresis',
      'Euro Sign',
      'Emoji: Grinning Face',
      'Hebrew Letter Dalet With Dagesh',
    ],
  );
});

test('canonicalJson sorts the keys of nested objects and of objects in arrays, and keeps the order of arrays, as the structures test of RFC 8785 expects', () => {
  const parsed: unknown = JSON.parse(
    '{"1": {"f": {"f": "hi","F": 5} ,"\\n": 56.0}, "10": { }, "": "empty", "a": { }, "111": [ {"e": "yes","E": "no" } ], "A": { }}',
  );

  assert.equal(
    canonicalJson(parsed),
    '{"":"empty","1":{"\\n":56,"f":{"F":5,"f":"hi"}},"10":{},"111":[{"E":"no","e":"yes"}],"A":{},"a":{}}',
  );
});

test('canonicalJson writes each finite number of RFC 8785, appendix B, as the table gives it', () => {
  // The IEEE 754 bits of each number, in hexadecimal, and its JSON.
  const samples: readonly (readonly [string, string])[] = [
    ['0000000000000000', '0'],
    ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'],
    ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'],
    ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'],
    ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ];

  for (const [bits, json] of samples) {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, BigInt(`0x${bits}`));
    assert.equal(canonicalJson([view.getFloat64(0)]), `[${json}]`, bits);
  }
});

test('canonicalJson leaves out a property that is undefined, as JSON.stringify does', () => {
  assert.equal(
    canonicalJson({ options: ['Login problems'], instructions: undefined }),
    '{"options":["Login problems"]}',
  );
});
