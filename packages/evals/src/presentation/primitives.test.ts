import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import {
  Bars,
  Heatmap,
  Line,
  Note,
  type Pair,
  type Primitive,
  type PrimitiveVisitor,
  Scatter,
  Table,
  ValuePairs,
} from '../index.ts';

// A visitor that names the method that the primitive called.
const names: PrimitiveVisitor<string> = {
  table: () => 'table',
  bars: () => 'bars',
  scatter: () => 'scatter',
  line: () => 'line',
  heatmap: () => 'heatmap',
  valuePairs: () => 'valuePairs',
  note: () => 'note',
};

void test.each(
  [
    {
      name: 'table',
      primitive: new Table(['score'], [[{ text: '0.9', tone: 'good' }]]),
    },
    {
      name: 'bars',
      primitive: new Bars({
        bars: [{ label: 'recall', value: 0.9, ends: undefined, tone: 'good' }],
        scale: { low: 0, high: 1 },
        marks: [{ label: 'bar', at: 0.88 }],
        table: new Table(['score'], [[{ text: 'recall', tone: 'good' }]]),
      }),
    },
    {
      name: 'scatter',
      primitive: new Scatter({
        x: 'Haiku',
        y: 'DeepSeek',
        points: [{ label: 'a', x: 0.5, y: 1 }],
        table: new Table(['test'], [[{ text: 'a', tone: 'neutral' }]]),
      }),
    },
    {
      name: 'line',
      primitive: new Line({
        steps: ['eval-1'],
        series: [
          { label: 'recall', values: [{ value: 0.9, ends: undefined }] },
        ],
        table: new Table(['run'], [[{ text: 'eval-1', tone: 'neutral' }]]),
      }),
    },
    {
      name: 'heatmap',
      primitive: new Heatmap({
        rows: ['a'],
        columns: ['eval-1'],
        values: [[0.5]],
        table: new Table(['test'], [[{ text: 'a', tone: 'neutral' }]]),
      }),
    },
    {
      name: 'valuePairs',
      primitive: new ValuePairs('a', [
        {
          path: '$.offers[0].kind',
          mark: 'agree',
          expected: 'credits',
          actual: 'credits',
        },
      ]),
    },
    { name: 'note', primitive: new Note('711 answers were replayed') },
  ] satisfies readonly { name: string; primitive: Primitive }[],
  ({ name, primitive }) =>
    test(`a ${name} calls the ${name} method of the visitor`, () => {
      assert.equal(primitive.accept(names), name);
    }),
);

test('a line refuses a series with another number of values than its steps', () => {
  assert.throws(
    () =>
      new Line({
        steps: ['eval-1', 'eval-2'],
        series: [
          { label: 'recall', values: [{ value: 0.9, ends: undefined }] },
        ],
        table: new Table(['run'], []),
      }),
    { name: 'RangeError', message: 'Series recall has 1 values for 2 steps' },
  );
});

test('a heatmap refuses values of another shape than its rows and columns', () => {
  assert.throws(
    () =>
      new Heatmap({
        rows: ['a', 'b'],
        columns: ['eval-1'],
        values: [[0.5]],
        table: new Table(['test'], []),
      }),
    {
      name: 'RangeError',
      message: 'A heatmap of 2 rows and 1 columns has values of another shape',
    },
  );
});

test('the type of each chart refuses a chart with no table', () => {
  const charts = [
    // @ts-expect-error Bars carry the table that a reader reads in their place.
    new Bars({ bars: [], scale: { low: 0, high: 1 }, marks: [] }),
    // @ts-expect-error A scatter carries the table of its points.
    new Scatter({ x: 'Haiku', y: 'DeepSeek', points: [] }),
    // @ts-expect-error A line carries the table of its steps.
    new Line({ steps: [], series: [] }),
    // @ts-expect-error A heatmap carries the table of its cells.
    new Heatmap({ rows: [], columns: [], values: [] }),
  ];

  // The charts still build at run time; the claims are the four type errors.
  assert.equal(charts.length, 4);
});

test('the type of a pair refuses a part that only one side has with the other side', () => {
  const onlyExpected: Pair = {
    path: '$.a',
    mark: 'only-expected',
    expected: '1',
    // @ts-expect-error A part that only the case has holds no actual value.
    actual: '2',
  };
  // @ts-expect-error A part that both sides have holds both values.
  const disagree: Pair = { path: '$.a', mark: 'disagree', expected: '1' };

  // The values still build at run time; the claims are the two type errors.
  assert.equal([onlyExpected, disagree].length, 2);
});
