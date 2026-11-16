import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import { MockEmbeddingModelV4 } from 'ai/test';

import { DecisionService, downloadHead } from '../index.ts';

// The prefix that the reader of DecisionService puts before each text.
const PREFIX = 'task: classification | query: ';

// The reader that Venn's service had in a fixture: the raw vector of each
// text after the Classification prefix, and no vector for another text.
export function goldenReader(
  raw: Readonly<Record<string, readonly number[]>>,
): MockEmbeddingModelV4 {
  const rows = new Map(
    Object.entries(raw).map(([text, row]) => [`${PREFIX}${text}`, row]),
  );
  return new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: null,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((value) => {
        const row = rows.get(value);
        if (row === undefined)
          throw new Error(`The fixture has no vector for ${value}`);
        return [...row];
      }),
      warnings: [],
    }),
  });
}

// A service over the venn-1 head, which the repository does not ship, so it
// is downloaded into the cache of Hugging Face. With no file at
// `registryPath`, each question divides by choice_temperature.
export async function goldenService(options: {
  readonly registryPath: string;
  readonly database: DatabaseSync;
  readonly model: MockEmbeddingModelV4;
}): Promise<DecisionService> {
  return DecisionService.load({
    ...options,
    directory: await downloadHead({ clock: globalThis }),
  });
}

// Compares each number to `tolerance` of max(1, |Venn's|), and each other
// value exactly.
export function assertClose(
  actual: unknown,
  expected: unknown,
  path: string,
  tolerance: number,
): void {
  if (typeof expected === 'number') {
    assert.ok(typeof actual === 'number', `${path} is not a number`);
    assert.ok(
      Math.abs(actual - expected) <=
        tolerance * Math.max(1, Math.abs(expected)),
      `${path}: ${actual} against Venn's ${expected}`,
    );
    return;
  }
  if (typeof expected !== 'object' || expected === null) {
    assert.equal(actual, expected, path);
    return;
  }
  assert.ok(typeof actual === 'object' && actual !== null, path);
  assert.deepEqual(Object.keys(actual), Object.keys(expected), path);
  for (const [key, value] of Object.entries(expected))
    assertClose(Reflect.get(actual, key), value, `${path}.${key}`, tolerance);
}
