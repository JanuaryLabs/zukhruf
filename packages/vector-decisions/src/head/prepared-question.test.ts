import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { test } from '@zukhruf/parameterized-test';

import {
  CosineAbstention,
  PreparedQuestion,
  type Tensor,
  loadWeights,
} from '../index.ts';

const TINY_HEAD = join(import.meta.dirname, 'fixtures/tiny-head.safetensors');
// Venn's logits in float64 (fixtures/generate.py) and the package's differ
// by at most 3e-15 of max(1, |logit|) (measured 2026-11-14).
const TOLERANCE = 1e-12;

type GoldenCase = {
  readonly name: string;
  readonly question: number[];
  readonly options: number[][];
  readonly states: number[][];
  readonly logits: number[][];
};

const tiny: { readonly cases: readonly GoldenCase[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/tiny-head.json'), 'utf8'),
);

function goldenCase(name: string): GoldenCase {
  const golden = tiny.cases.find((candidate) => candidate.name === name);
  assert.ok(golden, name);
  return golden;
}

// The logits of PreparedQuestion equal those of Venn's PreparedQuestion for
// the same head and vectors.
function assertVennLogits(head: CosineAbstention, golden: GoldenCase): void {
  const logits = new PreparedQuestion(
    head,
    Float32Array.from(golden.question),
    golden.options.map((option) => Float32Array.from(option)),
  ).logits(golden.states.map((state) => Float32Array.from(state)));

  assert.equal(logits.length, golden.logits.length);
  for (const [row, expected] of golden.logits.entries()) {
    const actual = logits[row];
    assert.ok(actual, `row ${row}`);
    assert.equal(actual.length, expected.length, `row ${row}`);
    for (const [column, value] of expected.entries()) {
      const got: number = actual[column] ?? Number.NaN;
      assert.ok(
        Math.abs(got - value) <= TOLERANCE * Math.max(1, Math.abs(value)),
        `row ${row}, column ${column}: ${got} against Venn's ${value}`,
      );
    }
  }
}

function unitVector(width: number, seed: number): Float32Array {
  const values = Float32Array.from({ length: width }, (_, index) =>
    Math.sin(seed * 31 + index),
  );
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
}

test('a vector whose width is not the width of the head is refused', async () => {
  const head = CosineAbstention.fromWeights(await loadWeights(TINY_HEAD));
  const question = unitVector(8, 1);
  const options = [unitVector(8, 2), unitVector(8, 3)];

  assert.throws(() => new PreparedQuestion(head, unitVector(6, 1), options), {
    name: 'DimensionMismatchError',
    message: /question has 6 numbers, but the head reads 8/,
  });
  assert.throws(
    () =>
      new PreparedQuestion(head, question, [
        unitVector(8, 2),
        unitVector(9, 3),
      ]),
    {
      name: 'DimensionMismatchError',
      message: /option 1 has 9 numbers, but the head reads 8/,
    },
  );
  assert.throws(
    () =>
      new PreparedQuestion(head, question, options).logits([
        unitVector(8, 4),
        unitVector(7, 5),
      ]),
    {
      name: 'DimensionMismatchError',
      message: /state 1 has 7 numbers, but the head reads 8/,
    },
  );
});

test('weights that lack a tensor of the head, or do not fit together, are refused', async () => {
  const weights = await loadWeights(TINY_HEAD);
  const without = new Map(weights);
  without.delete('none.2.weight');
  const scalar = (value: number): Tensor => ({
    shape: [],
    values: Float32Array.of(value),
  });
  const misfit = new Map(weights);
  misfit.set('none.0.bias', {
    shape: [5],
    values: new Float32Array(5),
  });
  const vector = new Map(weights);
  vector.set('temperature', { shape: [2], values: Float32Array.of(1, 2) });
  const odd = new Map(weights);
  odd.set('none.0.weight', { shape: [4, 15], values: new Float32Array(60) });
  const flat = new Map(weights);
  flat.set('none.0.weight', { shape: [64], values: new Float32Array(64) });

  assert.throws(() => CosineAbstention.fromWeights(without), {
    name: 'InvalidHeadWeightsError',
    message: /none\.2\.weight is missing/,
  });
  assert.throws(() => CosineAbstention.fromWeights(misfit), {
    name: 'InvalidHeadWeightsError',
    message: /none\.0\.bias has the shape \[5\], but the head needs \[4\]/,
  });
  assert.throws(() => CosineAbstention.fromWeights(vector), {
    name: 'InvalidHeadWeightsError',
    message: /temperature has the shape \[2\], but the head needs \[\]/,
  });
  for (const [first, shape] of [
    [odd, '4, 15'],
    [flat, '64'],
  ] as const)
    assert.throws(() => CosineAbstention.fromWeights(first), {
      name: 'InvalidHeadWeightsError',
      message: new RegExp(
        String.raw`none\.0\.weight has the shape \[${shape}\], but the head needs \[hidden, 2 × width\]`,
      ),
    });
  assert.ok(
    CosineAbstention.fromWeights(new Map([...weights, ['extra', scalar(1)]])),
  );
});

void test.each(['2 options', '3 options', '5 options'], (name) =>
  test(`the logits equal the logits of Venn for a question with ${name}`, async () => {
    const head = CosineAbstention.fromWeights(await loadWeights(TINY_HEAD));

    assertVennLogits(head, goldenCase(name));
  }),
);

void test.each(['1 option', 'equal options', 'tiny options'], (name) =>
  test(`an option or a question that centering makes zero or tiny gives the logits of Venn, not NaN, ${name}`, async () => {
    const head = CosineAbstention.fromWeights(await loadWeights(TINY_HEAD));

    assertVennLogits(head, goldenCase(name));
  }),
);

test('a question with no option gives only the logit of none, as Venn gives it', async () => {
  const head = CosineAbstention.fromWeights(await loadWeights(TINY_HEAD));

  assertVennLogits(head, goldenCase('no option'));
});
