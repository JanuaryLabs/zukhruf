import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Ratio, ScorerSet } from '../../index.ts';
import {
  ConfigCase,
  JsonSchema,
  JsonValue,
  RequiredKeyRecall,
  TreeWalk,
} from '../index.ts';

// An answer is a list of offers, and each offer must have a kind and a value.
const offers = new JsonSchema(
  JsonValue.from({
    type: 'object',
    properties: {
      offers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            value: { type: 'number' },
            tiers: {
              type: 'array',
              items: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
              },
            },
          },
          required: ['kind', 'value'],
        },
      },
    },
    required: ['offers'],
  }),
  { draft: '7' },
);

const ratios = (stated: unknown, schema: JsonSchema = offers) =>
  Object.fromEntries(
    new ScorerSet(
      {
        'as evaluate.py': new RequiredKeyRecall(),
        'stated items only': new RequiredKeyRecall({ statedItemsOnly: true }),
      },
      { comparer: new TreeWalk() },
    ).score(stated, new ConfigCase({ schema }).from({ expected: {} })).ratios,
  );

test('with statedItemsOnly, an answer with an empty array has every required key, as the keys of an item are required only of an item; without it the keys of the items count, as evaluate.py counts them', () => {
  assert.deepEqual(ratios({ offers: [] }), {
    'as evaluate.py': new Ratio(1, 3),
    'stated items only': new Ratio(1, 1),
  });
});

test('with statedItemsOnly, an answer without the array lacks the array alone', () => {
  assert.deepEqual(ratios({}), {
    'as evaluate.py': new Ratio(0, 3),
    'stated items only': new Ratio(0, 1),
  });
});

test('with statedItemsOnly, an item that lacks a required key still lacks it', () => {
  assert.deepEqual(ratios({ offers: [{ kind: 'credits' }] }), {
    'as evaluate.py': new Ratio(2, 3),
    'stated items only': new Ratio(2, 3),
  });
});

test('with statedItemsOnly, the keys of the items of an inner array are required only where an item of the outer array has an item of the inner one', () => {
  const tiersRequired = new JsonSchema(
    JsonValue.from({
      type: 'object',
      properties: {
        offers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tiers: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                  required: ['name'],
                },
              },
            },
            required: ['tiers'],
          },
        },
      },
      required: ['offers'],
    }),
    { draft: '7' },
  );

  assert.deepEqual(ratios({ offers: [{ tiers: [] }] }, tiersRequired), {
    'as evaluate.py': new Ratio(2, 3),
    'stated items only': new Ratio(2, 2),
  });
  assert.deepEqual(ratios({ offers: [{ tiers: [{}] }] }, tiersRequired), {
    'as evaluate.py': new Ratio(2, 3),
    'stated items only': new Ratio(2, 3),
  });
});
