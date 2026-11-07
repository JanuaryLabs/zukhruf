import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigCase, JsonSchema, JsonValue, TextVarsCase } from '../index.ts';

test('TextVarsCase reads vars.expected as JSON text without loss, its weight, and builds each schema with its function, by default with the draft of its $schema or 2020-12', () => {
  const draft7 = { $schema: 'http://json-schema.org/draft-07/schema#' };
  const ownDraft = new TextVarsCase();
  const forced = new TextVarsCase({
    schema: (value) => new JsonSchema(value, { draft: '7' }),
  });

  const row = ownDraft.from({ expected: '{"a": 7.0}', schema: {}, weight: 3 });

  // 7.0 stays a float (a number), where an int would be a bigint.
  assert.deepEqual(row.expected, new Map([['a', 7.0]]));
  assert.equal(row.weight, 3);
  assert.equal(row.schema?.draft, '2020-12');
  assert.equal(
    ownDraft.from({ expected: '{}', schema: draft7 }).schema?.draft,
    '7',
  );
  assert.equal(forced.from({ expected: '{}', schema: {} }).schema?.draft, '7');
  assert.equal(ownDraft.from({ expected: '{}' }).weight, 1);
  assert.equal(ownDraft.from({ expected: '{}' }).schema, undefined);
});

test('ConfigCase reads config.expected as a JavaScript value, gives every case its one schema, and weighs each case 1', () => {
  const schema = new JsonSchema(JsonValue.from({ type: 'object' }));
  const cases = new ConfigCase({ schema });

  const first = cases.from({ expected: { a: 7 }, weight: 3 });
  const second = cases.from({ expected: null });

  assert.deepEqual(first.expected, new Map([['a', 7n]]));
  assert.equal(first.schema, schema);
  assert.equal(second.schema, schema);
  assert.equal(second.expected, null);
  assert.equal(first.weight, 1);
  assert.equal(new ConfigCase().from({ expected: {} }).schema, undefined);
});

test('JsonValue.parse throws a SyntaxError for text that is not JSON, so a reader can skip the line', () => {
  assert.throws(() => JsonValue.parse('{"metadata": '), SyntaxError);
});

test('a config case needs config.expected, and a text vars case needs vars.expected as JSON text and a weight that is a number', () => {
  assert.throws(
    () => new ConfigCase().from({ schema: {} }),
    /config\.expected/,
  );
  assert.throws(
    () => new TextVarsCase().from({ expected: {} }),
    /vars\.expected as JSON text/,
  );
  assert.throws(
    () => new TextVarsCase().from({ expected: '{}', weight: 'heavy' }),
    /vars\.weight is a number, not "heavy"/,
  );
});
