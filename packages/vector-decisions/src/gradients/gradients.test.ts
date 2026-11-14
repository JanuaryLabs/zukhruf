import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { AdamW } from './adamw.ts';
import { AttentionPooling } from './attention-pooling.ts';
import { CrossEntropyLoss } from './cross-entropy-loss.ts';
import { GELU } from './gelu.ts';
import { Linear } from './linear.ts';
import { LowRankBilinear } from './low-rank-bilinear.ts';
import { Matrix } from './matrix.ts';
import { Normalize } from './normalize.ts';
import { Parameter } from './parameter.ts';

type Rows = number[][];

// For each step, one matrix for each parameter.
type AdamWSteps = {
  readonly parameters: Rows[];
  readonly gradients: Rows[][];
  readonly after: Rows[][];
};

// PyTorch's float64 forward of each module (fixtures/generate.py).
const golden: {
  readonly linear: {
    readonly input: Rows;
    readonly weight: Rows;
    readonly bias: Rows;
    readonly output: Rows;
  };
  readonly gelu: { readonly input: Rows; readonly output: Rows };
  readonly lowRankBilinear: {
    readonly states: Rows;
    readonly options: Rows;
    readonly left: Rows;
    readonly right: Rows;
    readonly output: Rows;
  };
  readonly crossEntropy: readonly {
    readonly name: string;
    readonly logits: Rows;
    readonly targets: number[];
    readonly weights: number[];
    readonly loss: number;
  }[];
  readonly attentionPooling: {
    readonly fields: Rows[];
    readonly questions: Rows;
    readonly query: Rows;
    readonly output: Rows;
  };
  readonly normalize: { readonly input: Rows; readonly output: Rows };
  readonly adamw: readonly (AdamWSteps & {
    readonly lr: number;
    readonly weightDecay: number;
  })[];
  readonly adamwDefaults: AdamWSteps;
} = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/expected.json'), 'utf8'),
);

// The outputs of the modules differ from PyTorch's by at most 6e-16 of
// max(1, |value|), and AdamW gives PyTorch's parameters bit for bit
// (measured 2026-11-14).
const GOLDEN_TOLERANCE = 1e-12;
// The step of the central finite differences, and their tolerance: 10 times
// the largest difference between a gradient and its finite difference in
// these tests, 4.7e-10 of max(1, |difference|) (measured 2026-11-14).
const STEP = 1e-6;
const GRADIENT_TOLERANCE = 5e-9;

// Each number of actual is within tolerance · max(1, |expected|) of expected.
function assertClose(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
  tolerance: number,
  label: string,
): void {
  assert.equal(actual.length, expected.length, label);
  for (let index = 0; index < expected.length; index++) {
    const got = actual[index] ?? Number.NaN;
    const want = expected[index] ?? Number.NaN;
    assert.ok(
      Math.abs(got - want) <= tolerance * Math.max(1, Math.abs(want)),
      `${label}[${index}]: ${got} against ${want}`,
    );
  }
}

// A seeded linear congruential generator (the constants of Numerical
// Recipes) of numbers in [-1, 1).
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 31 - 1;
  };
}

function randomMatrix(
  random: () => number,
  rows: number,
  columns: number,
): Matrix {
  return new Matrix(
    rows,
    columns,
    Float64Array.from({ length: rows * columns }, random),
  );
}

// An integer from low to high.
function size(random: () => number, low: number, high: number): number {
  return low + Math.floor(((random() + 1) / 2) * (high - low + 1));
}

// The loss whose gradient with respect to the output of a pass is upstream.
function dot(output: Matrix, upstream: Matrix): number {
  return output.values.reduce(
    (sum, value, index) => sum + value * (upstream.values[index] ?? 0),
    0,
  );
}

// The central finite difference of loss with respect to each number of
// values, which it changes in place and then restores.
function finiteDifferences(
  values: Float64Array,
  loss: () => number,
  step = STEP,
): Float64Array {
  return Float64Array.from(values, (value, index) => {
    values[index] = value + step;
    const plus = loss();
    values[index] = value - step;
    const minus = loss();
    values[index] = value;
    return (plus - minus) / (2 * step);
  });
}

test('a matrix whose numbers, rows or factors do not fit is refused', () => {
  const left = new Matrix(2, 3);

  assert.throws(() => new Matrix(2, 3, new Float64Array(5)), {
    name: 'RangeError',
    message: /A 2 × 3 matrix holds 6 numbers, not 5/,
  });
  assert.throws(() => Matrix.fromRows([[1, 2], [3]]), { name: 'RangeError' });
  assert.throws(() => left.times(new Matrix(2, 3)), {
    name: 'RangeError',
    message: /2 × 3 and 2 × 3 do not fit in times/,
  });
  assert.throws(() => left.timesTransposed(new Matrix(3, 2)), {
    name: 'RangeError',
    message: /2 × 3 and 3 × 2 do not fit in timesTransposed/,
  });
  assert.throws(() => left.transposedTimes(new Matrix(3, 3)), {
    name: 'RangeError',
    message: /2 × 3 and 3 × 3 do not fit in transposedTimes/,
  });
});

test('the output of Linear equals the output of nn.Linear of PyTorch', () => {
  const { input, weight, bias, output } = golden.linear;
  const linear = new Linear(Matrix.fromRows(weight), Matrix.fromRows(bias));

  const actual = linear.forward(Matrix.fromRows(input)).output;

  assert.deepEqual([actual.rows, actual.columns], [4, 3]);
  assertClose(actual.values, output.flat(), GOLDEN_TOLERANCE, 'output');
});

test('a bias that is not one row of the outputs of the weight is refused', () => {
  const weight = new Matrix(3, 2);

  for (const bias of [new Matrix(1, 2), new Matrix(3, 1)])
    assert.throws(() => new Linear(weight, bias), {
      name: 'RangeError',
      message: new RegExp(
        `The bias of 3 outputs is 1 × 3, not ${bias.rows} × ${bias.columns}`,
      ),
    });
});

test('the gradients of the weight, the bias and the input of Linear equal central finite differences', () => {
  const random = generator(1);
  for (const [inputs, outputs, batch] of [
    [3, 2, 4],
    [1, 4, 1],
    [5, 3, 2],
  ] as const) {
    const linear = new Linear(
      randomMatrix(random, outputs, inputs),
      randomMatrix(random, 1, outputs),
    );
    const input = randomMatrix(random, batch, inputs);
    const upstream = randomMatrix(random, batch, outputs);
    const loss = () => dot(linear.forward(input).output, upstream);

    const pass = linear.forward(input);
    pass.accumulate(upstream);
    const inputGradient = pass.pullback(upstream);

    for (const [name, parameter] of [
      ['weight', linear.weight],
      ['bias', linear.bias],
    ] as const)
      assertClose(
        parameter.gradient.values,
        finiteDifferences(parameter.value.values, loss),
        GRADIENT_TOLERANCE,
        `${inputs} → ${outputs}, ${name}`,
      );
    assertClose(
      inputGradient.values,
      finiteDifferences(input.values, loss),
      GRADIENT_TOLERANCE,
      `${inputs} → ${outputs}, input`,
    );
  }
});

test('the output of GELU equals nn.GELU of PyTorch, the exact form, from -8 to 8', () => {
  const { input, output } = golden.gelu;

  const actual = new GELU().forward(Matrix.fromRows(input)).output;

  assert.deepEqual([actual.rows, actual.columns], [3, 4]);
  assertClose(actual.values, output.flat(), GOLDEN_TOLERANCE, 'output');
});

test('the gradient of the input of GELU equals central finite differences', () => {
  const random = generator(2);
  for (const [rows, columns] of [
    [2, 3],
    [1, 5],
    [4, 1],
  ] as const) {
    const input = new Matrix(
      rows,
      columns,
      randomMatrix(random, rows, columns).values.map((value) => value * 4),
    );
    const upstream = randomMatrix(random, rows, columns);
    const gelu = new GELU();
    const loss = () => dot(gelu.forward(input).output, upstream);

    const inputGradient = gelu.forward(input).pullback(upstream);

    assertClose(
      inputGradient.values,
      finiteDifferences(input.values, loss),
      GRADIENT_TOLERANCE,
      `${rows} × ${columns}`,
    );
  }
});

test('the scores of LowRankBilinear equal left(states) @ right(options).T of PyTorch for every pair', () => {
  const { states, options, left, right, output } = golden.lowRankBilinear;
  const bilinear = new LowRankBilinear(
    Matrix.fromRows(left),
    Matrix.fromRows(right),
  );

  const actual = bilinear.forward(
    Matrix.fromRows(states),
    Matrix.fromRows(options),
  ).output;

  assert.deepEqual([actual.rows, actual.columns], [4, 3]);
  assertClose(actual.values, output.flat(), GOLDEN_TOLERANCE, 'output');
});

test('a left and a right factor of different ranks are refused', () => {
  assert.throws(() => new LowRankBilinear(new Matrix(2, 6), new Matrix(3, 5)), {
    name: 'RangeError',
    message: /The left factor has rank 2, but the right factor has rank 3/,
  });
});

test('the gradients of the left and right factors and of the states of LowRankBilinear equal central finite differences', () => {
  const random = generator(3);
  for (const [stateWidth, optionWidth, rank, batch, count] of [
    [4, 3, 2, 3, 2],
    [1, 5, 1, 2, 4],
    [5, 2, 3, 1, 3],
  ] as const) {
    const bilinear = new LowRankBilinear(
      randomMatrix(random, rank, stateWidth),
      randomMatrix(random, rank, optionWidth),
    );
    const states = randomMatrix(random, batch, stateWidth);
    const options = randomMatrix(random, count, optionWidth);
    const upstream = randomMatrix(random, batch, count);
    const loss = () => dot(bilinear.forward(states, options).output, upstream);

    const pass = bilinear.forward(states, options);
    pass.accumulate(upstream);
    const statesGradient = pass.pullback(upstream);

    for (const [name, parameter] of [
      ['left', bilinear.left],
      ['right', bilinear.right],
    ] as const)
      assertClose(
        parameter.gradient.values,
        finiteDifferences(parameter.value.values, loss),
        GRADIENT_TOLERANCE,
        `rank ${rank}, ${name}`,
      );
    assertClose(
      statesGradient.values,
      finiteDifferences(states.values, loss),
      GRADIENT_TOLERANCE,
      `rank ${rank}, states`,
    );
  }
});

test('the loss of CrossEntropyLoss equals the weighted cross-entropy of PyTorch over logits that Venn masks with -1e4, and over logits near 1000', () => {
  for (const { name, logits, targets, weights, loss } of golden.crossEntropy) {
    const actual = new CrossEntropyLoss().forward(
      Matrix.fromRows(logits),
      targets,
      weights,
    ).output;

    assertClose([actual], [loss], GOLDEN_TOLERANCE, name);
  }
});

test('targets or weights that do not fit the rows of logits are refused', () => {
  const logits = new Matrix(2, 3);
  const loss = new CrossEntropyLoss();

  assert.throws(() => loss.forward(logits, [0], [1, 1]), {
    name: 'RangeError',
    message: /2 rows of logits have 1 targets and 2 weights/,
  });
  assert.throws(() => loss.forward(logits, [0, 1], [1, 1, 1]), {
    name: 'RangeError',
    message: /2 rows of logits have 2 targets and 3 weights/,
  });
  for (const target of [3, -1, 0.5])
    assert.throws(() => loss.forward(logits, [0, target], [1, 1]), {
      name: 'RangeError',
      message: new RegExp(
        `The target ${target} of row 1 is not one of the 3 columns`,
      ),
    });
});

test('the gradient of the logits of CrossEntropyLoss equals central finite differences, and a masked logit gets 0', () => {
  const random = generator(4);
  for (const [rows, columns] of [
    [3, 4],
    [1, 2],
    [4, 5],
  ] as const) {
    const logits = randomMatrix(random, rows, columns);
    const targets = Array.from({ length: rows }, () =>
      size(random, 0, columns - 1),
    );
    const masked = Array.from(
      { length: rows },
      (_, row) => ((targets[row] ?? 0) + 1) % columns,
    );
    for (const [row, column] of masked.entries())
      logits.values[row * columns + column] = -1e4;
    const weights = Array.from({ length: rows }, () => (random() + 1) * 2);
    const upstream = random();
    const crossEntropy = new CrossEntropyLoss();
    const loss = () =>
      crossEntropy.forward(logits, targets, weights).output * upstream;

    const logitsGradient = crossEntropy
      .forward(logits, targets, weights)
      .pullback(upstream);

    assertClose(
      logitsGradient.values,
      finiteDifferences(logits.values, loss),
      GRADIENT_TOLERANCE,
      `${rows} × ${columns}`,
    );
    for (const [row, column] of masked.entries())
      assert.ok(
        logitsGradient.values[row * columns + column] === 0,
        `${rows} × ${columns}: masked logit of row ${row}`,
      );
  }
});

test('the pooled states of AttentionPooling equal the pool of Venn before its normalization', () => {
  const { fields, questions, query, output } = golden.attentionPooling;
  const pooling = new AttentionPooling(Matrix.fromRows(query));

  const actual = pooling.forward(
    fields.map((state) => Matrix.fromRows(state)),
    Matrix.fromRows(questions),
  ).output;

  assert.deepEqual([actual.rows, actual.columns], [2, 4]);
  assertClose(actual.values, output.flat(), GOLDEN_TOLERANCE, 'output');
});

test('a count of states that is not the count of questions is refused', () => {
  const pooling = new AttentionPooling(new Matrix(4, 4));

  assert.throws(() => pooling.forward([new Matrix(3, 4)], new Matrix(2, 4)), {
    name: 'RangeError',
    message: /1 states of fields have 2 questions/,
  });
});

test('the gradient of the query of AttentionPooling equals central finite differences', () => {
  const random = generator(5);
  for (const [width, questionWidth, count, batch] of [
    [3, 2, 4, 2],
    [4, 4, 2, 3],
    [1, 3, 3, 1],
  ] as const) {
    const pooling = new AttentionPooling(
      randomMatrix(random, width, questionWidth),
    );
    const fields = Array.from({ length: batch }, () =>
      randomMatrix(random, count, width),
    );
    const questions = randomMatrix(random, batch, questionWidth);
    const upstream = randomMatrix(random, batch, width);
    const loss = () => dot(pooling.forward(fields, questions).output, upstream);

    pooling.forward(fields, questions).accumulate(upstream);

    assertClose(
      pooling.query.gradient.values,
      finiteDifferences(pooling.query.value.values, loss),
      GRADIENT_TOLERANCE,
      `${count} fields of ${width}`,
    );
  }
});

test('the rows of Normalize equal F.normalize of PyTorch, and a zero row or a row whose norm is below 1e-12 does not become NaN', () => {
  const { input, output } = golden.normalize;

  const actual = new Normalize().forward(Matrix.fromRows(input)).output;

  assert.deepEqual([actual.rows, actual.columns], [4, 5]);
  assertClose(actual.values, output.flat(), GOLDEN_TOLERANCE, 'output');
});

test('the gradient of the input of Normalize equals central finite differences, for a zero row and a row below 1e-12 too', () => {
  const random = generator(6);
  for (const [rows, columns] of [
    [3, 4],
    [1, 5],
    [2, 1],
  ] as const) {
    const input = randomMatrix(random, rows, columns);
    const upstream = randomMatrix(random, rows, columns);
    const normalize = new Normalize();
    const loss = () => dot(normalize.forward(input).output, upstream);

    const inputGradient = normalize.forward(input).pullback(upstream);

    assertClose(
      inputGradient.values,
      finiteDifferences(input.values, loss),
      GRADIENT_TOLERANCE,
      `${rows} × ${columns}`,
    );
  }
  const small = new Matrix(
    2,
    3,
    Float64Array.of(
      0,
      0,
      0,
      ...randomMatrix(random, 1, 3).values.map((value) => value * 1e-14),
    ),
  );
  const upstream = randomMatrix(random, 2, 3);
  const normalize = new Normalize();
  const loss = () => dot(normalize.forward(small).output, upstream);

  const smallGradient = normalize.forward(small).pullback(upstream);

  assertClose(
    smallGradient.values,
    finiteDifferences(small.values, loss, 1e-15),
    GRADIENT_TOLERANCE,
    'rows below 1e-12',
  );
});

test('the parameters after each step of AdamW equal those of torch.optim.AdamW for the weight decays of Venn', () => {
  for (const {
    lr,
    weightDecay,
    parameters,
    gradients,
    after,
  } of golden.adamw) {
    const trained = parameters.map(
      (rows) => new Parameter(Matrix.fromRows(rows)),
    );
    const optimizer = new AdamW(trained, { lr, weightDecay });

    for (const [step, stepGradients] of gradients.entries()) {
      for (const [index, parameter] of trained.entries())
        parameter.gradient.values.set(stepGradients[index]?.flat() ?? []);
      optimizer.step();

      for (const [index, parameter] of trained.entries())
        assertClose(
          parameter.value.values,
          after[step]?.[index]?.flat() ?? [],
          GOLDEN_TOLERANCE,
          `weight decay ${weightDecay}, step ${step + 1}, parameter ${index}`,
        );
    }
  }
});

test('a second backward pass adds to the gradients, and zeroGrad of AdamW sets every gradient to 0', () => {
  const linear = new Linear(
    Matrix.fromRows([
      [1, 2],
      [3, 4],
    ]),
    Matrix.fromRows([[0.5, -0.5]]),
  );
  const input = Matrix.fromRows([[1, -1]]);
  const upstream = Matrix.fromRows([[2, 3]]);
  const optimizer = new AdamW([linear.weight, linear.bias]);

  linear.forward(input).accumulate(upstream);
  linear.forward(input).accumulate(upstream);

  assert.deepEqual([...linear.weight.gradient.values], [4, -4, 6, -6]);
  assert.deepEqual([...linear.bias.gradient.values], [4, 6]);

  optimizer.zeroGrad();

  assert.deepEqual([...linear.weight.gradient.values], [0, 0, 0, 0]);
  assert.deepEqual([...linear.bias.gradient.values], [0, 0]);
});

test('a gradient whose shape is not the shape of the parameter is refused', () => {
  const parameter = new Parameter(new Matrix(2, 2));

  assert.throws(() => parameter.accumulate(new Matrix(1, 4)), {
    name: 'RangeError',
    message: /A 1 × 4 gradient does not fit a 2 × 2 parameter/,
  });
});

test('AdamW with no options steps as torch.optim.AdamW with its defaults, lr 1e-3 and weight decay 0.01', () => {
  const { parameters, gradients, after } = golden.adamwDefaults;
  const trained = parameters.map(
    (rows) => new Parameter(Matrix.fromRows(rows)),
  );
  const optimizer = new AdamW(trained);

  for (const [step, stepGradients] of gradients.entries()) {
    for (const [index, parameter] of trained.entries())
      parameter.gradient.values.set(stepGradients[index]?.flat() ?? []);
    optimizer.step();

    for (const [index, parameter] of trained.entries())
      assertClose(
        parameter.value.values,
        after[step]?.[index]?.flat() ?? [],
        GOLDEN_TOLERANCE,
        `step ${step + 1}, parameter ${index}`,
      );
  }
});
