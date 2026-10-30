// The tabulate 0.10.0 behavior that pandas' DataFrame.to_markdown depends on:
// tabulate(rows, headers, tablefmt="pipe", showindex=False) with the other
// defaults (floatfmt "g", intfmt "", missingval "", numalign "decimal",
// stralign "left", numparse on, whitespace stripped). Without wcwidth, as
// tabulate measures text when it cannot import wcwidth: the width of a text
// is its number of code points. ANSI escape codes, separating lines and
// bytes are not ported.
import {
  pythonFloat,
  pythonFloatRepr,
  pythonFormatG,
  pythonIsInt,
  pythonSplitlines,
  pythonStrip,
} from './python.ts';

// A value of a row as Python gives it to tabulate: str, float, bool or
// None.
export type TabulateValue = string | number | boolean | null;

// The types of _more_generic, from the least generic.
type ValueType = 'none' | 'bool' | 'int' | 'float' | 'str';
const GENERALITY: Readonly<Record<ValueType, number>> = {
  none: 0,
  bool: 1,
  int: 2,
  float: 3,
  str: 5,
};

type Alignment = 'decimal' | 'left';

// MIN_PADDING: the space that a header gets around its text.
const MIN_PADDING = 2;

// _float_with_thousands_separators. Python's conditional group (?(1)...)
// becomes two branches, and its $ also matches before a last newline.
const THOUSANDS =
  /^(?:[+-]?[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]*)?|(?:\.[0-9]+)?)\n?$/;

// tabulate(rows, headers, tablefmt="pipe") with pandas' defaults. Each row
// has a value for each header.
export function tabulate(
  headers: readonly string[],
  rows: readonly (readonly TabulateValue[])[],
): string {
  // Without columns, zip(*cols) gives no rows either: an empty table.
  if (headers.length === 0) return '';
  const plainText = [...headers, ...rows.flat().map(pythonStr)].join('\t');
  const multiline = /[\r\n]/.test(plainText);
  const width = multiline ? multilineWidth : textWidth;
  const columns = headers.map((_, index) =>
    rows.map((row) => row[index] ?? null),
  );
  const types = rows.length === 0 ? [] : columns.map(columnType);
  const formatted = types.map((type, index) =>
    (columns[index] ?? []).map((value) => format(value, type)),
  );
  const aligns: Alignment[] = types.map((type) =>
    type === 'int' || type === 'float' ? 'decimal' : 'left',
  );
  const minWidths = headers.map((header) => width(header) + MIN_PADDING);
  const aligned = formatted.map((strings, index) =>
    alignColumn(
      strings,
      aligns[index] ?? 'left',
      minWidths[index] ?? 0,
      multiline,
    ),
  );
  const headerColumns = aligned.length > 0 ? aligned : headers.map(() => ['']);
  const headerAligns: Alignment[] =
    aligns.length > 0 ? aligns : headers.map(() => 'left');
  const widths = minWidths.map((minWidth, index) =>
    Math.max(minWidth, ...(headerColumns[index] ?? []).map(width)),
  );
  const alignedHeaders = headers.map((header, index) =>
    alignHeader(
      header,
      headerAligns[index] ?? 'left',
      widths[index] ?? 0,
      multiline,
    ),
  );
  const alignedRows = rows.map((_, row) =>
    aligned.map((column) => column[row] ?? ''),
  );
  return formatTable(alignedHeaders, alignedRows, widths, aligns, multiline);
}

// str(value).
function pythonStr(value: TabulateValue): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return pythonFloatRepr(value);
  return value;
}

// _isnumber_with_thousands_separator.
function isNumberWithThousandsSeparator(value: TabulateValue): boolean {
  return typeof value === 'string' && THOUSANDS.test(value);
}

// _isnumber: float(value) works, and for a text the result is finite or the
// text is "inf", "-inf" or "nan".
function isNumber(value: TabulateValue): boolean {
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (value === null) return false;
  const number = pythonFloat(value);
  if (number === undefined) return false;
  return (
    Number.isFinite(number) ||
    ['inf', '-inf', 'nan'].includes(value.toLowerCase())
  );
}

// _isint: only a text can be an int here, since a number is a float.
function isInt(value: TabulateValue): boolean {
  return typeof value === 'string' && pythonIsInt(value);
}

// _isbool.
function isBool(value: TabulateValue): boolean {
  return typeof value === 'boolean' || value === 'True' || value === 'False';
}

// _type: the least generic type of a value. An empty text counts as None.
function valueType(value: TabulateValue): ValueType {
  if (value === null || value === '') return 'none';
  if (isBool(value)) return 'bool';
  if (
    isInt(value) ||
    (isNumberWithThousandsSeparator(value) && !String(value).includes('.'))
  )
    return 'int';
  if (isNumber(value) || isNumberWithThousandsSeparator(value)) return 'float';
  return 'str';
}

// _column_type: reduce(_more_generic, types, bool).
function columnType(values: readonly TabulateValue[]): ValueType {
  return values
    .map(valueType)
    .reduce<ValueType>(
      (left, right) => (GENERALITY[left] >= GENERALITY[right] ? left : right),
      'bool',
    );
}

// _format of a value of a column of the given type.
function format(value: TabulateValue, type: ValueType): string {
  if (value === null) return '';
  if (value === '') return '';
  if (type === 'int')
    return typeof value === 'string' ? value : pythonStr(value);
  if (type === 'float') {
    if (typeof value !== 'string') return pythonFormatG(Number(value));
    const text = value.replaceAll(',', '');
    const number = pythonFloat(text);
    return number === undefined ? text : pythonFormatG(number);
  }
  return pythonStr(value);
}

// _afterpoint: the number of characters after the decimal point (or after
// the e of an exponent), or -1 for an integer or a text that is no number.
function afterPoint(text: string): number {
  if (!isNumber(text) && !isNumberWithThousandsSeparator(text)) return -1;
  if (isInt(text)) return -1;
  const chars = [...text];
  let position = chars.lastIndexOf('.');
  if (position < 0) position = [...text.toLowerCase()].lastIndexOf('e');
  return position >= 0 ? chars.length - position - 1 : -1;
}

// len(text): the number of code points.
function textWidth(text: string): number {
  return [...text].length;
}

// _multiline_width: the width of the widest line.
function multilineWidth(text: string): number {
  return Math.max(...text.split(/[\r\n]/).map(textWidth));
}

// "{0:>%ds}".format(text).
function padLeft(width: number, text: string): string {
  return ' '.repeat(Math.max(0, width - textWidth(text))) + text;
}

// "{0:<%ds}".format(text).
function padRight(width: number, text: string): string {
  return text + ' '.repeat(Math.max(0, width - textWidth(text)));
}

// _align_column: a decimal column pads each number on the right until the
// decimal points line up, then flushes right; a left column strips the
// whitespace, then flushes left. A multiline cell pads each of its lines.
function alignColumn(
  strings: readonly string[],
  alignment: Alignment,
  minWidth: number,
  multiline: boolean,
): string[] {
  let texts: string[];
  let pad: (width: number, text: string) => string;
  if (alignment === 'decimal') {
    const decimals = strings.map(afterPoint);
    const most = Math.max(...decimals);
    texts = strings.map(
      (text, index) => text + ' '.repeat(most - (decimals[index] ?? 0)),
    );
    pad = padLeft;
  } else {
    texts = strings.map(pythonStrip);
    pad = padRight;
  }
  const lineWidths = multiline
    ? texts.flatMap((text) => text.split(/[\r\n]/).map(textWidth))
    : texts.map(textWidth);
  const width = Math.max(...lineWidths, minWidth);
  return multiline
    ? texts.map((text) =>
        pythonSplitlines(text)
          .map((line) => pad(width, line))
          .join('\n'),
      )
    : texts.map((text) => pad(width, text));
}

// _align_header: a header flushes right over a decimal column, left over
// any other.
function alignHeader(
  header: string,
  alignment: Alignment,
  width: number,
  multiline: boolean,
): string {
  const pad = alignment === 'left' ? padRight : padLeft;
  if (!multiline) return pad(width, header);
  return header
    .split(/\r|\n|\r\n/)
    .map((line) => pad(width, line))
    .join('\n');
}

// _pipe_segment_with_colons and _pipe_line_with_colons: a colon marks the
// side that a column flushes to. A table without rows has no alignments.
function pipeLine(
  widths: readonly number[],
  aligns: readonly Alignment[],
): string {
  const segments = widths.map((width, index) => {
    const align = aligns[index];
    if (align === 'decimal') return `${'-'.repeat(width - 1)}:`;
    if (align === 'left') return `:${'-'.repeat(width - 1)}`;
    return '-'.repeat(width);
  });
  return `|${segments.join('|')}|`;
}

// _build_simple_row of the pipe format: each cell padded with one space.
function pipeRow(cells: readonly string[]): string {
  return `|${cells.map((cell) => ` ${cell} `).join('|')}|`.trimEnd();
}

// _format_table of the pipe format with a header: no line above the header,
// a line with colons below it, no line between rows or below the table. A
// multiline row is a line for each line of its tallest cell; a shorter cell
// continues with blank lines.
function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  widths: readonly number[],
  aligns: readonly Alignment[],
  multiline: boolean,
): string {
  const padded = widths.map((width) => width + 2);
  const lines: string[] = [];
  const append = (cells: readonly string[]) => {
    if (!multiline) {
      lines.push(pipeRow(cells));
      return;
    }
    const cellLines = cells.map((cell) => pythonSplitlines(cell));
    const count = Math.max(...cellLines.map((cell) => cell.length));
    for (let line = 0; line < count; line++)
      lines.push(
        pipeRow(
          cellLines.map(
            (cell, index) => cell[line] ?? ' '.repeat(widths[index] ?? 0),
          ),
        ),
      );
  };
  append(headers);
  lines.push(pipeLine(padded, aligns));
  for (const row of rows) append(row);
  return lines.join('\n');
}
