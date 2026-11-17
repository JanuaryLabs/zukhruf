import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import {
  CosineAbstention,
  PreparedQuestion,
  downloadHead,
  loadWeights,
  modelDirectory,
} from '../index.ts';

// Venn's logits in float64 (fixtures/generate.py) and the package's differ
// by at most 3e-15 of max(1, |logit|) (measured 2026-11-14).
const TOLERANCE = 1e-12;

const golden: {
  readonly cases: readonly {
    readonly question: number[];
    readonly options: number[][];
    readonly states: number[][];
    readonly logits: number[][];
  }[];
} = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/venn-1.json'), 'utf8'),
);

test('the venn-1 head, downloaded, checked and read, gives the logits of Venn', async () => {
  await using cache = await new TemporaryFiles().directory(
    'vector-decisions-hub-',
  );
  const directory = await modelDirectory(
    await downloadHead({ cacheDir: cache.path, clock: globalThis }),
  );
  const head = CosineAbstention.fromWeights(
    await loadWeights(join(directory, 'universal.safetensors')),
  );

  for (const { question, options, states, logits } of golden.cases) {
    const actual = new PreparedQuestion(
      head,
      Float32Array.from(question),
      options.map((option) => Float32Array.from(option)),
    ).logits(states.map((state) => Float32Array.from(state)));
    assert.equal(actual.length, logits.length);
    for (const [row, expected] of logits.entries()) {
      assert.equal(actual[row]?.length, expected.length, `row ${row}`);
      for (const [column, value] of expected.entries()) {
        const got: number = actual[row]?.[column] ?? Number.NaN;
        assert.ok(
          Math.abs(got - value) <= TOLERANCE * Math.max(1, Math.abs(value)),
          `row ${row}, column ${column}: ${got} against Venn's ${value}`,
        );
      }
    }
  }
});
