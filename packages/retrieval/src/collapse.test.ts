import assert from 'node:assert/strict';

import { test } from '@zukhruf/testing/node';

import { Collapse } from './index.ts';

const scored = (
  id: string,
  source: string,
  score: number,
  metadata: Readonly<Record<string, unknown>> = {},
) => ({
  passage: { id, text: id, source, seq: 0, start: 0, end: 0, metadata },
  score,
});

const ids = (
  results: readonly { readonly passage: { readonly id: string } }[],
) => results.map(({ passage }) => passage.id);

test('by default a Collapse keeps the first passage of each source, in the order of the list', async () => {
  // Arrange
  const collapse = new Collapse();

  // Act
  const results = await collapse.postprocess([
    scored('guide-1', 'guide', 0.2),
    scored('notes-1', 'notes', 0.5),
    scored('guide-2', 'guide', 0.9),
    scored('notes-2', 'notes', 0.4),
    scored('faq-1', 'faq', 0.7),
  ]);

  // Assert: guide-1 and notes-1 come first of their source, faq alone; the
  // scores are not read.
  assert.deepEqual(
    results.map(({ passage, score }) => [passage.id, score]),
    [
      ['guide-1', 0.2],
      ['notes-1', 0.5],
      ['faq-1', 0.7],
    ],
  );
});

test('a Collapse on a metadata field keeps the best size passages of each value', async () => {
  // Arrange
  const collapse = new Collapse({ field: 'metadata.product', size: 2 });

  // Act
  const results = await collapse.postprocess([
    scored('v1', 'a', 0.9, { product: 'vault' }),
    scored('v2', 'b', 0.8, { product: 'vault' }),
    scored('k1', 'c', 0.7, { product: 'kms' }),
    scored('v3', 'd', 0.6, { product: 'vault' }),
    scored('k2', 'e', 0.5, { product: 'kms' }),
    scored('k3', 'f', 0.4, { product: 'kms' }),
  ]);

  // Assert: v3 and k3 are the third of their product.
  assert.deepEqual(ids(results), ['v1', 'v2', 'k1', 'k2']);
});

test('the passages without a value for the field, absent or null, are one group, as Elasticsearch collapses a missing value under the key null', async () => {
  // Arrange
  const collapse = new Collapse({ field: 'metadata.product' });

  // Act
  const results = await collapse.postprocess([
    scored('absent', 'a', 0.9),
    scored('vault', 'b', 0.8, { product: 'vault' }),
    scored('null', 'c', 0.7, { product: null }),
  ]);

  // Assert: null is in the group of the absent value, which absent leads.
  assert.deepEqual(ids(results), ['absent', 'vault']);
});

test('of passages with equal scores the one first in the list is kept and comes first', async () => {
  // Arrange
  const collapse = new Collapse();

  // Act
  const results = await collapse.postprocess([
    scored('notes-1', 'notes', 0.5),
    scored('guide-1', 'guide', 0.5),
    scored('guide-2', 'guide', 0.5),
    scored('notes-2', 'notes', 0.5),
  ]);

  // Assert
  assert.deepEqual(ids(results), ['notes-1', 'guide-1']);
});

test('a Collapse on a passage field groups by the value of that field', async () => {
  // Arrange
  const collapse = new Collapse({ field: 'seq' });
  const at = (id: string, seq: number, score: number) => ({
    passage: { id, text: id, source: id, seq, start: 0, end: 0, metadata: {} },
    score,
  });

  // Act
  const results = await collapse.postprocess([
    at('guide-0', 0, 0.9),
    at('notes-0', 0, 0.8),
    at('notes-1', 1, 0.7),
  ]);

  // Assert: guide-0 and notes-0 share seq 0, from different sources.
  assert.deepEqual(ids(results), ['guide-0', 'notes-1']);
});

test('a Collapse keeps the order of the list, of a list of order only and of a scored list alike', async () => {
  // Arrange: each passage has its own source, so each is kept; the second
  // list gives each passage a score that its place does not follow.
  const collapse = new Collapse();
  const ranked = (id: string) => ({
    passage: {
      id,
      text: id,
      source: id,
      seq: 0,
      start: 0,
      end: 0,
      metadata: {},
    },
  });

  // Act
  const order = await collapse.postprocess([
    ranked('web'),
    ranked('low'),
    ranked('high'),
  ]);
  const all = await collapse.postprocess([
    { ...ranked('web'), score: 0.5 },
    scored('low', 'low', 0.1),
    scored('high', 'high', 0.9),
  ]);

  // Assert
  assert.deepEqual(ids(order), ['web', 'low', 'high']);
  assert.deepEqual(ids(all), ['web', 'low', 'high']);
});
