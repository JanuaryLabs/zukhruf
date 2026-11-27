import type {
  Bars,
  Ends,
  Heatmap,
  Line,
  Mark,
  Scatter,
  Tone,
} from '../index.ts';

// The icon and the word of each mark of a value pair, so that a mark never
// reads by colour alone.
export const marks: Readonly<
  Record<Mark, { readonly icon: string; readonly label: string }>
> = {
  agree: { icon: '✓', label: 'agrees' },
  near: { icon: '≈', label: 'near' },
  disagree: { icon: '✗', label: 'disagrees' },
  'only-expected': { icon: '−', label: 'only expected' },
  'only-actual': { icon: '+', label: 'only actual' },
};

// The icon of a tone beside its colour; a neutral value has none.
export const tones: Readonly<Record<Tone, string>> = {
  good: '✓',
  bad: '✗',
  neutral: '',
};

// The numbers of a chart as rows of text: the table view below a chart of
// the HTML page, and the table of the Markdown page.
export type DataTable = {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
};

// A number that a value does not have shows as a dash (mteb's `known`).
export const fixed = (value: number) =>
  Number.isNaN(value) ? '—' : value.toFixed(3);

// A value with its interval, such as 0.868 [0.800, 0.930]. An interval with
// no known end, as a missing value has, is left out.
export const withEnds = (value: number, ends: Ends | undefined) =>
  ends === undefined || (Number.isNaN(ends.low) && Number.isNaN(ends.high))
    ? fixed(value)
    : `${fixed(value)} [${fixed(ends.low)}, ${fixed(ends.high)}]`;

export const barsTable = (bars: Bars): DataTable => ({
  columns: ['Bar', 'Value', 'Low', 'High'],
  rows: bars.bars.map(({ label, value, ends }) =>
    ends === undefined
      ? [label, fixed(value), '', '']
      : [label, fixed(value), fixed(ends.low), fixed(ends.high)],
  ),
});

export const marksTable = (bars: Bars): DataTable => ({
  columns: ['Mark', 'At'],
  rows: bars.marks.map(({ label, at }) => [label, fixed(at)]),
});

export const scatterTable = (scatter: Scatter): DataTable => ({
  columns: ['Test', scatter.x, scatter.y],
  rows: scatter.points.map(({ label, x, y }) => [label, fixed(x), fixed(y)]),
});

export const lineTable = (line: Line): DataTable => ({
  columns: ['Step', ...line.series.map(({ label }) => label)],
  rows: line.steps.map((step, index) => [
    step,
    // Each series has a value for each step (the Line constructor checks it).
    ...line.series.flatMap(({ values }) =>
      values
        .slice(index, index + 1)
        .map((point) => withEnds(point.value, point.ends)),
    ),
  ]),
});

export const heatmapTable = (heatmap: Heatmap): DataTable => ({
  columns: ['', ...heatmap.columns],
  rows: heatmap.rows.map((row, index) => [
    row,
    // A row of values for each row (the Heatmap constructor checks it).
    ...heatmap.values
      .slice(index, index + 1)
      .flat()
      .map(fixed),
  ]),
});
