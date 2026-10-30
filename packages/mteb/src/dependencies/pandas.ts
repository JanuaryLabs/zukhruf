// The pandas 3.1.0 behavior that MTEB's tables depend on: a frame from
// columns, drop, explode, pivot_table(...).reset_index() and
// groupby(...).agg(...).reset_index(), for the dtypes that MTEB's tables have,
// and the writers to_csv, to_markdown and to_latex with index=False.
import { EOL } from 'node:os';

import { addReduceat } from './numpy.ts';
import {
  compareStrings,
  pythonFloatRepr,
  pythonFormatFixed,
  pythonStrRepr,
} from './python.ts';
import { type TabulateValue, tabulate } from './tabulate.ts';

// A value of a table. NaN is a number, as in a float64 column.
export type Cell = string | number | boolean | null;

// A column label. An array is the label of a MultiIndex column: one value for
// each level.
export type ColumnLabel = Cell | readonly Cell[];

// The function that aggregates the scores of a group, in the order of the
// rows. NaN scores are in the array.
export type AggregationFn = (values: readonly number[]) => number;

// A value of a frame before the aggregation. A list is an object cell, such
// as the languages of a subset.
export type Value = Cell | readonly Cell[];

// A table: column labels and rows of values, without an index, as a pandas
// DataFrame after reset_index. The writers see each column with the dtype
// that pd.DataFrame(rows, columns=...) infers for it: float64 when each cell
// is a number or null and one is a number (null is NaN); bool when each cell
// is a boolean; str when each cell is a string, null or NaN and one is a
// string (null is NaN); object for any other column, also one of nulls only
// or a table without rows. Column labels are all arrays of one length (a
// MultiIndex) or all cells.
export class DataFrame {
  readonly columns: readonly ColumnLabel[];
  readonly rows: readonly (readonly Cell[])[];

  constructor(
    columns: readonly ColumnLabel[] = [],
    rows: readonly (readonly Cell[])[] = [],
  ) {
    this.columns = columns;
    this.rows = rows;
  }

  // An aligned text table: a line for each level of the column labels, then
  // a line for each row. Floats have 6 decimals. pandas prints its repr
  // with an index column and its own float format.
  toString(): string {
    const levels = Math.max(
      1,
      ...this.columns.map((column) =>
        Array.isArray(column) ? column.length : 1,
      ),
    );
    const header = Array.from({ length: levels }, (_, level) =>
      this.columns.map((column) => {
        const labels: readonly Cell[] = isCell(column) ? [column] : column;
        return level < labels.length ? format(labels[level] ?? null) : '';
      }),
    );
    const body = this.rows.map((row) => row.map((value) => format(value)));
    const widths = this.columns.map((_, index) =>
      Math.max(...[...header, ...body].map((line) => line[index]?.length ?? 0)),
    );
    const numeric = this.columns.map(
      (_, index) =>
        this.rows.length > 0 &&
        this.rows.every((row) => typeof row[index] === 'number'),
    );
    const line = (texts: readonly string[]) =>
      texts
        .map((text, index) =>
          numeric[index]
            ? text.padStart(widths[index] ?? 0)
            : text.padEnd(widths[index] ?? 0),
        )
        .join('  ')
        .trimEnd();
    return [...header, ...body].map(line).join('\n');
  }

  // df.to_csv(index=False): a line for each level of the column labels, then
  // a line for each row, each ended by os.linesep. A float is its repr, a
  // missing value is empty, and a field with a comma, a quote, a carriage
  // return or a newline is quoted (csv.QUOTE_MINIMAL), its quotes doubled.
  toCsv(): string {
    return [
      ...this.#levels(),
      ...this.rows.map((row) =>
        this.columns.map((_, index) => row[index] ?? null),
      ),
    ]
      .map((cells) => `${csvRecord(cells.map(csvField))}${EOL}`)
      .join('');
  }

  // df.to_markdown(index=False): tabulate's pipe table of the column labels
  // (str of a label, repr of the tuple of a MultiIndex label) and of the
  // values. A missing value of a float64 or str column is NaN, so it shows
  // as nan; a None of an object column shows as nothing.
  toMarkdown(): string {
    const dtypes = this.#dtypes();
    const levels = this.#levels();
    return tabulate(
      isMultiIndex(this.columns)
        ? this.columns.map((_, index) =>
            tupleRepr(levels.map((labels) => labels[index] ?? null)),
          )
        : (levels[0] ?? []).map(str),
      this.rows.map((row) =>
        this.columns.map((_, index): TabulateValue => {
          const cell = row[index] ?? null;
          const dtype = dtypes[index];
          return cell === null && (dtype === 'float64' || dtype === 'str')
            ? NaN
            : cell;
        }),
      ),
    );
  }

  // df.to_latex(index=False, escape=escape), which renders through Styler: a
  // booktabs tabular whose float64 and bool columns align right (r) and the
  // others left (l), a header line for each level of the column labels, and
  // a line for each row. A float has 6 decimals, a missing value is NaN.
  // Equal labels next to each other on a level above the last one, under
  // equal labels on the levels above, merge into \multicolumn{n}{r}{label}.
  // With escape, the LaTeX specials of each text are escaped.
  toLatex(options: { readonly escape?: boolean } = {}): string {
    const escape = options.escape ?? false;
    const value = (cell: Cell) => latexValue(cell, escape);
    const levels = this.#levels();
    const columnFormat = this.#dtypes()
      .map((dtype) => (dtype === 'float64' || dtype === 'bool' ? 'r' : 'l'))
      .join('');
    const head =
      this.columns.length === 0
        ? []
        : levels.map((labels, level) =>
            headerSpans(levels, level)
              .map(([start, span]) => {
                const label = value(labels[start] ?? null);
                return span > 1 ? `\\multicolumn{${span}}{r}{${label}}` : label;
              })
              .join(' & '),
          );
    const body = this.rows.map((row) =>
      this.columns.map((_, index) => value(row[index] ?? null)).join(' & '),
    );
    return [
      `\\begin{tabular}{${columnFormat}}`,
      '\\toprule',
      ...head.map((line) => `${line} \\\\`),
      '\\midrule',
      ...body.map((line) => `${line} \\\\`),
      '\\bottomrule',
      '\\end{tabular}',
      '',
    ].join('\n');
  }

  // The dtype of each column.
  #dtypes(): Dtype[] {
    return this.columns.map((_, index) =>
      dtypeOf(this.rows.map((row) => row[index] ?? null)),
    );
  }

  // The column labels as levels: one for a flat index, one for each level of
  // a MultiIndex.
  #levels(): Cell[][] {
    if (!isMultiIndex(this.columns)) {
      if (this.columns.some((label) => !isCell(label)))
        throw new TypeError(
          'A DataFrame has array labels on every column (a MultiIndex) or on none.',
        );
      return [this.columns.filter(isCell)];
    }
    const labels = this.columns.filter(
      (label): label is readonly Cell[] => !isCell(label),
    );
    const depth = labels[0]?.length ?? 0;
    if (labels.some((label) => label.length !== depth))
      throw new TypeError(
        'The labels of a MultiIndex have one value for each level.',
      );
    return Array.from({ length: depth }, (_, level) =>
      labels.map((label) => label[level] ?? null),
    );
  }
}

// The frame that MTEB aggregates: named columns, and cells that can hold a
// list.
export class Frame {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly Value[])[];

  constructor(columns: readonly string[], rows: readonly (readonly Value[])[]) {
    this.columns = columns;
    this.rows = rows;
  }

  // pd.DataFrame(dict_of_lists). pandas reads a column of numbers and None
  // as float64, so None is NaN there.
  static fromColumns(data: Readonly<Record<string, readonly Value[]>>): Frame {
    const names = Object.keys(data);
    const columns = names.map((name) => {
      const values = data[name] ?? [];
      const numeric =
        values.every((value) => value === null || typeof value === 'number') &&
        values.some((value) => value !== null);
      return numeric
        ? values.map((value) => (value === null ? NaN : value))
        : values;
    });
    const length = columns[0]?.length ?? 0;
    return new Frame(
      names,
      Array.from({ length }, (_, row) =>
        columns.map((column) => column[row] ?? null),
      ),
    );
  }

  // df.drop(columns=names).
  drop(names: readonly string[]): Frame {
    const kept = this.columns.flatMap((column, index) =>
      names.includes(column) ? [] : [index],
    );
    return new Frame(
      kept.map((index) => this.columns[index] ?? ''),
      this.rows.map((row) => kept.map((index) => row[index] ?? null)),
    );
  }

  // df.explode(column).reset_index(drop=True): a row for each item of the
  // list in the column. An empty list gives one row with NaN, here null.
  explode(name: string): Frame {
    const at = this.#indexOf(name);
    return new Frame(
      this.columns,
      this.rows.flatMap((row) => {
        const value = row[at] ?? null;
        if (isCell(value)) return [row];
        if (value.length === 0) return [row.with(at, null)];
        return value.map((item) => row.with(at, item));
      }),
    );
  }

  // df.pivot_table(index, columns, values, aggfunc, observed=True)
  // .reset_index(), with dropna=True and sort=True. A group whose aggregate
  // is NaN is dropped before the unstack, so a row or a column of NaN only
  // does not appear. More than one column level gives MultiIndex labels, and
  // reset_index pads the labels of the index columns with "".
  pivotTable(options: {
    readonly index: readonly string[];
    readonly columns: readonly string[];
    readonly values: string;
    readonly aggfunc: AggregationFn | undefined;
  }): DataFrame {
    const groups = this.#groups(
      [...options.index, ...options.columns],
      options.values,
      options.aggfunc,
    ).filter((group) => !Number.isNaN(group.value));
    const width = options.index.length;
    const rowKeys = uniqueKeys(
      groups.map((group) => group.key.slice(0, width)),
    );
    const columnKeys = uniqueKeys(
      groups.map((group) => group.key.slice(width)),
    );
    const cells = new Map(
      groups.map((group) => [JSON.stringify(group.key), group.value]),
    );
    const multi = options.columns.length > 1;
    return new DataFrame(
      [
        ...options.index.map((name) =>
          multi ? [name, ...options.columns.slice(1).map(() => '')] : name,
        ),
        ...columnKeys.map((key) => (multi ? key : (key[0] ?? null))),
      ],
      rowKeys.map((rowKey) => [
        ...rowKey,
        ...columnKeys.map(
          (columnKey) =>
            cells.get(JSON.stringify([...rowKey, ...columnKey])) ?? NaN,
        ),
      ]),
    );
  }

  // df.groupby(keys, observed=True).agg(name=(values, aggfunc))
  // .reset_index(), with dropna=True and sort=True. A group whose aggregate
  // is NaN stays.
  groupbyAgg(options: {
    readonly keys: readonly string[];
    readonly values: string;
    readonly name: string;
    readonly aggfunc: AggregationFn | undefined;
  }): DataFrame {
    return new DataFrame(
      [...options.keys, options.name],
      this.#groups(options.keys, options.values, options.aggfunc).map(
        (group) => [...group.key, group.value],
      ),
    );
  }

  #indexOf(name: string): number {
    const index = this.columns.indexOf(name);
    if (index === -1) throw new Error(`KeyError: '${name}'`);
    return index;
  }

  // The groups of the rows by the keys, sorted, with their aggregates. A row
  // with a missing key (None, or NaN, which is null in a key here) is in no
  // group.
  #groups(
    keys: readonly string[],
    values: string,
    aggfunc: AggregationFn | undefined,
  ): { readonly key: readonly Cell[]; readonly value: number }[] {
    const keyIndexes = keys.map((key) => this.#indexOf(key));
    const valueIndex = this.#indexOf(values);
    const rows = this.rows.map((row) => {
      const key = keyIndexes.map((index) => hashable(row[index] ?? null));
      const value = row[valueIndex] ?? null;
      if (typeof value !== 'number')
        throw new TypeError(`Cannot aggregate ${JSON.stringify(value)}`);
      return { key: key.includes(null) ? null : key, value };
    });
    const groups = new Map<string, { key: Cell[]; values: number[] }>();
    for (const { key, value } of rows) {
      if (key === null) continue;
      const id = JSON.stringify(key);
      const group = groups.get(id) ?? { key, values: [] };
      group.values.push(value);
      groups.set(id, group);
    }
    const sorted = [...groups.values()].sort((left, right) =>
      compareKeys(left.key, right.key),
    );
    if (aggfunc !== undefined)
      return sorted.map((group) => ({
        key: group.key,
        value: aggfunc(group.values),
      }));
    // BaseGrouper._cython_operation: when the group number of each row, -1
    // for a missing key, never decreases and no value is NaN, pandas takes
    // np.add.reduceat of the groups divided by their sizes
    // (_reduceat_aggregate). Else the Cython group_mean.
    const numbers = new Map(
      sorted.map((group, number) => [JSON.stringify(group.key), number]),
    );
    const ids = rows.map(({ key }) =>
      key === null ? -1 : (numbers.get(JSON.stringify(key)) ?? -1),
    );
    const reduceat =
      ids.every((id, index) => index === 0 || (ids[index - 1] ?? -1) <= id) &&
      rows.every(({ value }) => !Number.isNaN(value));
    return sorted.map((group) => ({
      key: group.key,
      value: reduceat
        ? (addReduceat(group.values, [0])[0] ?? NaN) / group.values.length
        : groupMean(group.values),
    }));
  }
}

// groupby mean (_libs/groupby.pyx group_mean): Kahan summation of the values
// that are not NaN, divided by their count; NaN for a group without one.
function groupMean(values: readonly number[]): number {
  let count = 0;
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    if (Number.isNaN(value)) continue;
    count += 1;
    const y = value - compensation;
    const t = sum + y;
    compensation = t - sum - y;
    // An infinite value makes the compensation NaN (GH#50367).
    if (Number.isNaN(compensation)) compensation = 0;
    sum = t;
  }
  return count === 0 ? NaN : sum / count;
}

function isCell(value: Value): value is Cell {
  return !Array.isArray(value);
}

// A group key must be hashable: pandas raises for a list.
function hashable(value: Value): Cell {
  if (isCell(value)) return value;
  throw new TypeError("unhashable type: 'list'");
}

// sort=True: each key level in the order of its values; False before True.
function compareKeys(left: readonly Cell[], right: readonly Cell[]): number {
  for (const [index, a] of left.entries()) {
    const b = right[index] ?? null;
    const order =
      typeof a === 'string' && typeof b === 'string'
        ? compareStrings(a, b)
        : Number(a) - Number(b);
    if (order !== 0) return order;
  }
  return 0;
}

export function uniqueKeys(keys: readonly (readonly Cell[])[]): Cell[][] {
  const unique = new Map(keys.map((key) => [JSON.stringify(key), [...key]]));
  return [...unique.values()].sort(compareKeys);
}

function format(value: Cell): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number')
    return Number.isNaN(value) ? 'NaN' : value.toFixed(6);
  return value;
}

// The dtype that pd.DataFrame(rows) infers for a column of cells.
type Dtype = 'float64' | 'bool' | 'str' | 'object';

function dtypeOf(cells: readonly Cell[]): Dtype {
  if (
    cells.some((cell) => typeof cell === 'number') &&
    cells.every((cell) => cell === null || typeof cell === 'number')
  )
    return 'float64';
  if (cells.length > 0 && cells.every((cell) => typeof cell === 'boolean'))
    return 'bool';
  if (
    cells.some((cell) => typeof cell === 'string') &&
    cells.every(
      (cell) => cell === null || typeof cell === 'string' || Number.isNaN(cell),
    )
  )
    return 'str';
  return 'object';
}

// Column labels that are all arrays: the labels of a MultiIndex.
function isMultiIndex(columns: readonly ColumnLabel[]): boolean {
  return columns.length > 0 && columns.every((label) => !isCell(label));
}

// str(value) of a Python value.
function str(value: Cell): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return pythonFloatRepr(value);
  return value;
}

// repr(tuple(label)).
function tupleRepr(label: readonly Cell[]): string {
  const items = label.map((value) =>
    typeof value === 'string' ? pythonStrRepr(value) : str(value),
  );
  return `(${items.join(', ')}${items.length === 1 ? ',' : ''})`;
}

// The text that the csv writer writes for a value: na_rep "" for a missing
// value, str for the others.
function csvField(value: Cell): string {
  if (value === null || Number.isNaN(value)) return '';
  return str(value);
}

// csv.writer(...).writerow(fields) with QUOTE_MINIMAL. A record of one empty
// field is "", so that it does not read back as a record of no field.
function csvRecord(fields: readonly string[]): string {
  if (fields.length === 1 && fields[0] === '') return '""';
  return fields
    .map((field) =>
      /[,"\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field,
    )
    .join(',');
}

// The display value of a cell in Styler.to_latex: na_rep "NaN" for a missing
// value, the escaped text of a string when escape is set, a float with 6
// decimals (styler.format.precision) and str for the others.
function latexValue(value: Cell, escape: boolean): string {
  if (value === null || Number.isNaN(value)) return 'NaN';
  if (typeof value === 'string') return escape ? escapeLatex(value) : value;
  if (typeof value === 'number') return pythonFormatFixed(value, 6);
  return str(value);
}

// _escape_latex of pandas/io/formats/style_render.py, with its placeholder
// for the backslash.
function escapeLatex(text: string): string {
  return text
    .replaceAll('\\', 'ab2§=§8yz')
    .replaceAll('ab2§=§8yz ', 'ab2§=§8yz\\space ')
    .replaceAll('&', '\\&')
    .replaceAll('%', '\\%')
    .replaceAll('$', '\\$')
    .replaceAll('#', '\\#')
    .replaceAll('_', '\\_')
    .replaceAll('{', '\\{')
    .replaceAll('}', '\\}')
    .replaceAll('~ ', '~\\space ')
    .replaceAll('~', '\\textasciitilde ')
    .replaceAll('^ ', '^\\space ')
    .replaceAll('^', '\\textasciicircum ')
    .replaceAll('ab2§=§8yz', '\\textbackslash ');
}

// The visible header cells of a level as [first column, span], as Styler
// sparsifies a MultiIndex (sparsify_labels): on a level above the last one,
// a label is hidden under the label before it when the two are equal on
// this level and on each level above it.
function headerSpans(
  levels: readonly (readonly Cell[])[],
  level: number,
): [start: number, span: number][] {
  const spans: [number, number][] = [];
  const width = levels[0]?.length ?? 0;
  for (let column = 0; column < width; column++) {
    const hidden =
      level < levels.length - 1 &&
      column > 0 &&
      levels
        .slice(0, level + 1)
        .every((labels) => Object.is(labels[column - 1], labels[column]));
    const last = spans.at(-1);
    if (hidden && last !== undefined) last[1] += 1;
    else spans.push([column, 1]);
  }
  return spans;
}
