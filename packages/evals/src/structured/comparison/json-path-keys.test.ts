import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Recall, ScorerSet } from '../../index.ts';
import {
  AllMatched,
  ByBestMatch,
  ByPosition,
  ComparisonSpec,
  ConfigCase,
  ItemMatches,
  JsonValue,
  NumberWithin,
  PerField,
  TreeWalk,
  ValueMatches,
} from '../index.ts';

// A key of a ComparisonSpec is a JSONPath query (RFC 9535) of a subset: the
// root identifier $, then child segments that each hold one name selector or
// the wildcard selector (ADR 0011, decision 3).

test('a key outside the JSONPath subset throws a SyntaxError when the spec is built, from arrays, fields and exclude, and the message names the subset', () => {
  const keys = [
    'offers[].x',
    'offers',
    '',
    ' $.a',
    '$.a ',
    '$..x',
    '$[0]',
    '$[?@.a]',
    '$[0:1]',
    "$['a','b']",
    '$[*',
    '$.a-b',
    '$.1a',
    '$.',
    "$['a",
    String.raw`$['a\x']`,
    String.raw`$["a\'"]`,
    "$['\\uDC00']",
    "$['\\uD83D']",
    "$['\\uD83Dx']",
    "$['\\uD83D\\u0041']",
    "$['\\uD83D\\uD83D']",
    "$['\\u00e']",
    "$['\\u00zz']",
    String.raw`$['\"']`,
    "$['a\u{1}']",
    "$['\u{D800}']",
    '$. a',
    '$.a ]',
  ];
  const options = {
    arrays: (key: string) => ({ arrays: { [key]: new ByPosition() } }),
    fields: (key: string) => ({ fields: { [key]: new NumberWithin(0) } }),
    exclude: (key: string) => ({ exclude: [key] }),
  };

  const accepted = Object.entries(options).flatMap(([option, build]) =>
    keys.flatMap((key) => {
      try {
        new ComparisonSpec(build(key));
        return [`${option} ${key}: built`];
      } catch (error) {
        const named =
          error instanceof SyntaxError &&
          error.message.startsWith(`${JSON.stringify(key)} is not a field`) &&
          error.message.includes('JSONPath query (RFC 9535)') &&
          error.message.includes('name selector') &&
          error.message.includes('wildcard selector');
        return named ? [] : [`${option} ${key}: ${String(error)}`];
      }
    }),
  );

  assert.deepEqual(accepted, []);
});

test('the dot form, the bracket form in either quotes, the .* wildcard and blank space between segments name one field', () => {
  const recall = (key: string) =>
    new ScorerSet(
      { recall: new Recall(new ValueMatches()) },
      {
        comparer: new TreeWalk(
          new ComparisonSpec({ fields: { [key]: new NumberWithin(0.5) } }),
        ),
      },
    )
      .score(
        { offers: [{ n: 10.4, m: 20 }] },
        new ConfigCase().from({ expected: { offers: [{ n: 10, m: 10 }] } }),
      )
      .ratios.get('recall')?.value;

  const values = [
    '$.offers[*].n',
    "$['offers'][*]['n']",
    '$["offers"][*]["n"]',
    '$.offers.*.n',
    "$ .offers [ * ] [ 'n' ]",
    "$\t.offers\n[*]\r['n']",
    '$.offers[*].m',
  ].map(recall);

  assert.deepEqual(values, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0]);
});

test('a quoted name is one step, also when it holds ".", "[" or "]" or is empty; [*] is each item', () => {
  const expected = {
    'a.b': 1,
    a: { b: 1 },
    'a[0]': 1,
    x: [1],
    'x]': 1,
    '': 1,
  };
  const stated = JsonValue.from({
    'a.b': 1.4,
    a: { b: 1.4 },
    'a[0]': 1.4,
    x: [1.4],
    'x]': 1.4,
    '': 1.4,
  });
  const agreeing = (key: string) =>
    new TreeWalk(
      new ComparisonSpec({ fields: { [key]: new NumberWithin(0.5) } }),
    )
      .compare(stated, new ConfigCase().from({ expected }))
      .leaves()
      .filter((pair) => pair.agrees)
      .map((pair) => pair.expected?.path.steps);

  const fields = [
    "$['a.b']",
    '$.a.b',
    "$['a[0]']",
    "$['x]']",
    '$.x[*]',
    "$['']",
  ].map(agreeing);

  assert.deepEqual(fields, [
    [['a.b']],
    [['a', 'b']],
    [['a[0]']],
    [['x]']],
    [['x', 0]],
    [['']],
  ]);
});

test('$ names the root: arrays aligns a root array by its key, and $[*] names its items', () => {
  const testCase = new ConfigCase().from({ expected: [10, 20] });
  const recall = (spec: ComparisonSpec) =>
    new ScorerSet(
      { recall: new Recall(new ValueMatches()) },
      { comparer: new TreeWalk(spec) },
    )
      .score([20.4, 10], testCase)
      .ratios.get('recall')?.value;

  const values = [
    new ComparisonSpec(),
    new ComparisonSpec({ arrays: { $: new ByBestMatch() } }),
    new ComparisonSpec({
      arrays: { $: new ByBestMatch() },
      fields: { '$[*]': new NumberWithin(0.5) },
    }),
  ].map(recall);

  assert.deepEqual(values, [0, 0.5, 1]);
});

test("exclude and arrays read the same keys: an excluded quoted name keeps the property of the same text under a, and $['xs'] aligns xs", () => {
  const comparison = new TreeWalk(
    new ComparisonSpec({
      arrays: { "$['xs']": new ByBestMatch() },
      exclude: ["$['a.b']", '$.xs[*].n'],
    }),
  ).compare(
    JsonValue.from({
      'a.b': 1,
      a: { b: 1 },
      xs: [{ k: 'b' }, { k: 'a', n: 1 }],
    }),
    new ConfigCase().from({
      expected: {
        'a.b': 1,
        a: { b: 1 },
        xs: [
          { k: 'a', n: 1 },
          { k: 'b', n: 2 },
        ],
      },
    }),
  );

  assert.deepEqual(
    comparison
      .leaves()
      .map((pair) => [
        pair.expected?.path.steps,
        pair.stated?.path.steps,
        pair.agrees,
      ]),
    [
      [['a', 'b'], ['a', 'b'], true],
      [['xs', 0, 'k'], ['xs', 1, 'k'], true],
      [['xs', 1, 'k'], ['xs', 0, 'k'], true],
    ],
  );
});

test('a quoted name reads the escapes of RFC 9535: \\\' \\" \\\\ \\/ \\b \\f \\n \\r \\t, \\u in either case, a surrogate pair, and the other quote unescaped', () => {
  const names = [
    "it's",
    'say "hi"',
    'a\\b',
    'a/b',
    '\b\f\n\r\t',
    '\u{E9}',
    '\u{1F600}',
  ];
  const expected = Object.fromEntries(names.map((name) => [name, 1]));
  const stated = JsonValue.from(
    Object.fromEntries(names.map((name) => [name, 1.4])),
  );
  const agreeing = (key: string) =>
    new TreeWalk(
      new ComparisonSpec({ fields: { [key]: new NumberWithin(0.5) } }),
    )
      .compare(stated, new ConfigCase().from({ expected }))
      .leaves()
      .filter((pair) => pair.agrees)
      .map((pair) => pair.expected?.path.steps);

  const fields = [
    String.raw`$['it\'s']`,
    `$["it's"]`,
    String.raw`$["say \"hi\""]`,
    `$['say "hi"']`,
    String.raw`$['a\\b']`,
    String.raw`$['a\/b']`,
    String.raw`$["\b\f\n\r\t"]`,
    "$['\\u00e9']",
    "$['\\u00E9']",
    "$['\\uD83D\\uDE00']",
  ].map(agreeing);

  assert.deepEqual(fields, [
    [["it's"]],
    [["it's"]],
    [['say "hi"']],
    [['say "hi"']],
    [['a\\b']],
    [['a/b']],
    [['\b\f\n\r\t']],
    [['\u{E9}']],
    [['\u{E9}']],
    [['\u{1F600}']],
  ]);
});

test('a label writes each field as JSONPath, with the bracket form of a Normalized Path for a name that is not a member-name-shorthand, and the label of a field is a key that names that field', () => {
  const expected = {
    xs: [{ k: 1 }],
    'a.b': 1,
    '': 1,
    "it's": 1,
    'a\\b': 1,
    '\n': 1,
    '\u{1}': 1,
    'caf\u{E9}': 1,
    'a[0]': 1,
    m: [[1]],
    Name: 1,
    _id: 1,
    a1: 1,
  };
  const stated = JsonValue.from({
    xs: [{ k: 1.4 }],
    'a.b': 1.4,
    '': 1.4,
    "it's": 1.4,
    'a\\b': 1.4,
    '\n': 1.4,
    '\u{1}': 1.4,
    'caf\u{E9}': 1.4,
    'a[0]': 1.4,
    m: [[1.4]],
    Name: 1.4,
    _id: 1.4,
    a1: 1.4,
  }).value;
  const testCase = new ConfigCase().from({ expected });

  const labels = [
    ...new ScorerSet(
      {
        leaves: new PerField(new Recall(new ValueMatches())),
        items: new PerField(new Recall(new ItemMatches())),
      },
      { comparer: new TreeWalk() },
    )
      .score(new JsonValue(stated), testCase)
      .ratios.keys(),
  ].map((label) => label.replace(/ (leaves|items)$/u, ''));
  const named = labels.map((label) =>
    new TreeWalk(
      new ComparisonSpec({ fields: { [label]: new NumberWithin(0.5) } }),
    )
      .compare(new JsonValue(stated), testCase)
      .leaves()
      .filter((pair) => pair.agrees)
      .map((pair) => String(pair.expected?.path.field)),
  );

  assert.deepEqual(
    labels.toSorted(),
    [
      "$['a[0]']",
      "$['']",
      "$['\\n']",
      "$['\\u0001']",
      "$['a.b']",
      "$['a\\\\b']",
      "$['it\\'s']",
      '$.caf\u{E9}',
      '$.m',
      '$.m[*]',
      '$.m[*][*]',
      '$.xs',
      '$.xs[*].k',
      '$.Name',
      '$._id',
      '$.a1',
    ].toSorted(),
  );
  assert.deepEqual(
    named,
    labels.map((label) =>
      label === '$.xs' || label === '$.m' || label === '$.m[*]' ? [] : [label],
    ),
  );
});

// A lone surrogate is a valid JSON key but has no JSONPath form, so the text
// escapes it for people to read, and no spec key can name it.
test('an explanation writes each path as JSONPath, with an index selector for each position: at the root, after a name and after a position; a lone surrogate in a key is escaped', () => {
  const explain = (stated: unknown, expected: unknown) =>
    new ScorerSet(
      { perfect: new AllMatched() },
      { comparer: new TreeWalk() },
    ).score(stated, new ConfigCase().from({ expected })).reason;

  const reasons = [
    explain([1, 3], [1, 2]),
    explain({ m: [[1, 3]], 'a.b': [5] }, { m: [[1, 2]], 'a.b': [4] }),
    explain({ '\u{D83D}': 2 }, { '\u{D83D}': 1 }),
  ];

  assert.deepEqual(reasons, [
    'perfect: $[1]: expected 2, stated 3',
    "perfect: $.m[0][1]: expected 2, stated 3; $['a.b'][0]: expected 4, stated 5",
    "perfect: $['\\ud83d']: expected 1, stated 2",
  ]);
});
