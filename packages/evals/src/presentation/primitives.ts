// The primitives of a page: data to draw, with no HTML (ADR 0008). A
// building block of any family builds them, and a renderer of ./report draws
// each one in its format. Each primitive has accept(visitor), and
// PrimitiveVisitor has one method for each primitive, so a new primitive does
// not compile until each renderer draws it (Visitor). Each chart (Bars,
// Scatter, Line, Heatmap) carries the table that a reader reads in its place,
// so a chart with no table cannot be built (ADR 0011).

// How a value reads beside its neighbours: good, bad, or neither.
export type Tone = 'good' | 'bad' | 'neutral';

// One cell of a table: its text, as the building block formatted it, and its
// tone.
export type Cell = { readonly text: string; readonly tone: Tone };

// The ends of an interval of a value.
export type Ends = { readonly low: number; readonly high: number };

// How a part of one answer reads against its case, in the words of the core:
// it agrees, it is near (it shares words), it disagrees, or only one side has
// it. A family names them in its own words (structured ADR 0014).
export type Mark =
  'agree' | 'near' | 'disagree' | 'only-expected' | 'only-actual';

export interface PrimitiveVisitor<R> {
  table(table: Table): R;
  bars(bars: Bars): R;
  scatter(scatter: Scatter): R;
  line(line: Line): R;
  heatmap(heatmap: Heatmap): R;
  valuePairs(pairs: ValuePairs): R;
  note(note: Note): R;
}

// Columns and rows of cells.
export class Table {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly Cell[])[];

  constructor(columns: readonly string[], rows: readonly (readonly Cell[])[]) {
    this.columns = columns;
    this.rows = rows;
  }

  accept<R>(visitor: PrimitiveVisitor<R>): R {
    return visitor.table(this);
  }
}

// A bar for each value on one scale, each with its interval when it has one,
// and a mark on the scale, such as a bar that a score must reach.
export class Bars {
  readonly bars: readonly {
    readonly label: string;
    readonly value: number;
    readonly ends: Ends | undefined;
    readonly tone: Tone;
  }[];
  readonly scale: Ends;
  readonly marks: readonly { readonly label: string; readonly at: number }[];
  readonly table: Table;

  constructor({
    bars,
    scale,
    marks,
    table,
  }: {
    readonly bars: Bars['bars'];
    readonly scale: Ends;
    readonly marks: Bars['marks'];
    readonly table: Table;
  }) {
    this.bars = bars;
    this.scale = scale;
    this.marks = marks;
    this.table = table;
  }

  accept<R>(visitor: PrimitiveVisitor<R>): R {
    return visitor.bars(this);
  }
}

// One point for each test: its value in one run on x and in another on y.
export class Scatter {
  readonly x: string;
  readonly y: string;
  readonly points: readonly {
    readonly label: string;
    readonly x: number;
    readonly y: number;
  }[];
  readonly table: Table;

  constructor({
    x,
    y,
    points,
    table,
  }: {
    readonly x: string;
    readonly y: string;
    readonly points: Scatter['points'];
    readonly table: Table;
  }) {
    this.x = x;
    this.y = y;
    this.points = points;
    this.table = table;
  }

  accept<R>(visitor: PrimitiveVisitor<R>): R {
    return visitor.scatter(this);
  }
}

// A value for each step, such as each run of a trend, one series for each
// name, each value with its interval when it has one.
export class Line {
  readonly steps: readonly string[];
  readonly series: readonly {
    readonly label: string;
    readonly values: readonly {
      readonly value: number;
      readonly ends: Ends | undefined;
    }[];
  }[];
  readonly table: Table;

  constructor({
    steps,
    series,
    table,
  }: {
    readonly steps: readonly string[];
    readonly series: Line['series'];
    readonly table: Table;
  }) {
    for (const { label, values } of series)
      if (values.length !== steps.length)
        throw new RangeError(
          `Series ${label} has ${values.length} values for ${steps.length} steps`,
        );
    this.steps = steps;
    this.series = series;
    this.table = table;
  }

  accept<R>(visitor: PrimitiveVisitor<R>): R {
    return visitor.line(this);
  }
}

// A value from 0 to 1 for each row and column, such as the score of each
// test in each run.
export class Heatmap {
  readonly rows: readonly string[];
  readonly columns: readonly string[];
  readonly values: readonly (readonly number[])[];
  readonly table: Table;

  constructor({
    rows,
    columns,
    values,
    table,
  }: {
    readonly rows: readonly string[];
    readonly columns: readonly string[];
    readonly values: readonly (readonly number[])[];
    readonly table: Table;
  }) {
    if (
      values.length !== rows.length ||
      values.some((row) => row.length !== columns.length)
    )
      throw new RangeError(
        `A heatmap of ${rows.length} rows and ${columns.length} columns has values of another shape`,
      );
    this.rows = rows;
    this.columns = columns;
    this.values = values;
    this.table = table;
  }

  accept<R>(visitor: PrimitiveVisitor<R>): R {
    return visitor.heatmap(this);
  }
}

// One part of an answer beside its case: both sides when it agrees, is near
// or disagrees, else the one side that has it.
export type Pair =
  | {
      readonly path: string;
      readonly mark: 'agree' | 'near' | 'disagree';
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly path: string;
      readonly mark: 'only-expected';
      readonly expected: string;
    }
  | {
      readonly path: string;
      readonly mark: 'only-actual';
      readonly actual: string;
    };

// The parts of one answer beside its case, each marked, under a title such
// as the test of the answer.
export class ValuePairs {
  readonly title: string;
  readonly pairs: readonly Pair[];

  constructor(title: string, pairs: readonly Pair[]) {
    this.title = title;
    this.pairs = pairs;
  }

  accept<R>(visitor: PrimitiveVisitor<R>): R {
    return visitor.valuePairs(this);
  }
}

// A sentence that the numbers need beside them, such as how many answers
// were replayed.
export class Note {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  accept<R>(visitor: PrimitiveVisitor<R>): R {
    return visitor.note(this);
  }
}

export type Primitive =
  Table | Bars | Scatter | Line | Heatmap | ValuePairs | Note;

// A claim and the primitives that show its numbers: what a building block
// gives (ADR 0008, report ADR 0002).
export interface Section {
  readonly id: string;
  readonly claim: string;
  readonly primitives: readonly Primitive[];
}
