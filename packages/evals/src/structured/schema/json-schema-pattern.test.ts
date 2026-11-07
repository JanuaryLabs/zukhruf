import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ConfigCase,
  type Draft,
  JsonSchema,
  JsonValue,
  SchemaCompliance,
  ScorerSet,
  TypePrecision,
} from '../index.ts';

// JSON Schema reads a pattern as ECMA-262 with the u flag (2020-12 Core §6.4,
// draft 7 Validation §4.3). SOB's evaluate.py reads it with Python's re, which
// gives other answers; the cases marked "Test-Suite" are from
// JSON-Schema-Test-Suite tests/draft2020-12/optional/ecmascript-regex.json and
// tests/draft7/optional/ecmascript-regex.json at commit 245a45a (see NOTICE).

const scorer = new ScorerSet({
  valid: new SchemaCompliance(),
  types: new TypePrecision(),
});

const drafts: readonly (Draft | undefined)[] = [undefined, '7'];

const schema = (value: object, draft: Draft | undefined) =>
  new JsonSchema(JsonValue.from(value), draft === undefined ? {} : { draft });

// If the pattern matches the text, at each place that reads a pattern, under
// 2020-12 (the default) and draft 7: the pattern keyword for SchemaCompliance,
// and a patternProperties name for SchemaCompliance and TypePrecision. A name
// that the pattern matches must be a string, any other name a number.
const matches = (pattern: string, text: string): boolean[] =>
  drafts.flatMap((draft) => {
    const byPattern = scorer.score(
      { v: text },
      new ConfigCase({
        schema: schema(
          { type: 'object', properties: { v: { type: 'string', pattern } } },
          draft,
        ),
      }).from({ expected: {} }),
    );
    const byName = scorer.score(
      { [text]: 'x' },
      new ConfigCase({
        schema: schema(
          {
            type: 'object',
            patternProperties: { [pattern]: { type: 'string' } },
            additionalProperties: { type: 'number' },
          },
          draft,
        ),
      }).from({ expected: {} }),
    );
    return [
      byPattern.ratios.get('valid')?.value === 1,
      byName.ratios.get('valid')?.value === 1,
      byName.ratios.get('types')?.value === 1,
    ];
  });

// If a schema with the pattern is valid, under 2020-12 and draft 7: as the
// pattern keyword and as a patternProperties name.
const valid = (pattern: string): boolean[] =>
  drafts.flatMap((draft) => [
    schema({ pattern }, draft).valid,
    schema({ patternProperties: { [pattern]: {} } }, draft).valid,
  ]);

const everywhere = (answer: boolean, places: number) =>
  Array.from({ length: places }, () => answer);

test('a pattern is valid as ECMA-262 with the u flag, not as Python re: \\p{L} and \\cC are valid (Python: invalid) and match "é" and U+0003, (?P<x>a) and a\\-b are invalid (Python: valid), and (?P<x>a) matches no name', () => {
  assert.deepEqual(valid('^\\p{L}$'), everywhere(true, 4));
  assert.deepEqual(valid('^\\cC$'), everywhere(true, 4)); // Test-Suite
  assert.deepEqual(valid('(?P<x>a)'), everywhere(false, 4));
  assert.deepEqual(valid('a\\-b'), everywhere(false, 4));
  assert.deepEqual(matches('^\\p{L}$', 'é'), everywhere(true, 6));
  assert.deepEqual(matches('^\\cC$', '\u0003'), everywhere(true, 6)); // Test-Suite
  // TypePrecision reads the types of an invalid schema too.
  const pythonOnly = drafts.map(
    (draft) =>
      scorer
        .score(
          { a: 'x' },
          new ConfigCase({
            schema: schema(
              {
                type: 'object',
                patternProperties: { '^(?P<x>a)$': { type: 'string' } },
                additionalProperties: { type: 'number' },
              },
              draft,
            ),
          }).from({ expected: {} }),
        )
        .ratios.get('types')?.value,
  );
  assert.deepEqual(pythonOnly, [0, 0]);
});

// Test-Suite: "ECMA 262 regex $ does not match trailing newline".
test('$ matches only at the end: ^abc$ matches "abc" and not "abc\\n" (Python: matches)', () => {
  assert.deepEqual(matches('^abc$', 'abc'), everywhere(true, 6));
  assert.deepEqual(matches('^abc$', 'abc\n'), everywhere(false, 6));
});

test('. matches no line terminator: ^.$ matches "x" and not "\\r" or U+2028 (Python: matches both)', () => {
  assert.deepEqual(matches('^.$', 'x'), everywhere(true, 6));
  assert.deepEqual(matches('^.$', '\r'), everywhere(false, 6));
  assert.deepEqual(matches('^.$', '\u{2028}'), everywhere(false, 6));
});

// Test-Suite: "ECMA 262 \d matches ascii digits only" and "\w matches ascii
// letters only".
test('\\d and \\w are ASCII only: ^\\d$ matches "0" and not NKO DIGIT ZERO, ^\\w$ matches "a" and not "é" (Python: matches both)', () => {
  assert.deepEqual(matches('^\\d$', '0'), everywhere(true, 6));
  assert.deepEqual(matches('^\\d$', '\u{07C0}'), everywhere(false, 6));
  assert.deepEqual(matches('^\\w$', 'a'), everywhere(true, 6));
  assert.deepEqual(matches('^\\w$', 'é'), everywhere(false, 6));
});

// Test-Suite: "ECMA 262 \s matches whitespace" (U+FEFF); U+001C from the
// probe matrix of #3861.
test('\\s is the ECMA-262 white space set: ^\\s$ matches U+FEFF (Python: does not) and not U+001C (Python: matches)', () => {
  assert.deepEqual(matches('^\\s$', '\u{FEFF}'), everywhere(true, 6));
  assert.deepEqual(matches('^\\s$', '\u001C'), everywhere(false, 6));
});

test('\\b is a boundary of ASCII word characters: \\bé matches "aé" (Python: does not) and not "é" (Python: matches)', () => {
  assert.deepEqual(matches('\\bé', 'aé'), everywhere(true, 6));
  assert.deepEqual(matches('\\bé', 'é'), everywhere(false, 6));
});
