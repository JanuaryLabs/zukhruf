import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EOL } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { type Cell, type ColumnLabel, DataFrame } from './pandas.ts';

// fixtures/pandas-writers/ holds tables and what pandas 3.1.0 (with
// tabulate 0.10.0) writes for each, with index=False: edge cases and each
// table of MTEB's to_dataframe in ../results/fixtures/to-dataframe.
// generate.py makes it. A float that JSON cannot hold is a string.
type Entry = {
  readonly name: string;
  readonly columns: readonly ColumnLabel[];
  readonly rows: readonly (readonly Cell[])[];
  readonly csv: string;
  readonly markdown: string;
  readonly latex: string;
  readonly latex_escaped: string;
};

const { tables }: { tables: readonly Entry[] } = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/pandas-writers/expected.json'),
    'utf8',
  ),
);

function frame(entry: Entry): DataFrame {
  const value = (cell: Cell) =>
    cell === 'NaN' || cell === 'Infinity' || cell === '-Infinity'
      ? Number(cell)
      : cell;
  return new DataFrame(
    entry.columns,
    entry.rows.map((row) => row.map(value)),
  );
}

// pandas ends each line with os.linesep, and generate.py ran where it is \n.
test(
  'toCsv writes what to_csv(index=False) writes, byte for byte',
  { skip: EOL !== '\n' && 'the fixture ends its lines with \\n' },
  () => {
    for (const entry of tables) {
      const df = frame(entry);

      const csv = df.toCsv();

      assert.equal(csv, entry.csv, entry.name);
    }
  },
);

test('toMarkdown writes what to_markdown(index=False) writes, byte for byte', () => {
  for (const entry of tables) {
    const df = frame(entry);

    const markdown = df.toMarkdown();

    assert.equal(markdown, entry.markdown, entry.name);
  }
});

test('toLatex writes what to_latex(index=False) writes, byte for byte', () => {
  for (const entry of tables) {
    const df = frame(entry);

    const latex = df.toLatex();

    assert.equal(latex, entry.latex, entry.name);
  }
});

test('toLatex({ escape: true }) writes what to_latex(index=False, escape=True) writes, byte for byte', () => {
  for (const entry of tables) {
    const df = frame(entry);

    const latex = df.toLatex({ escape: true });

    assert.equal(latex, entry.latex_escaped, entry.name);
  }
});

test('the fixture has the edge cases and every table of the to-dataframe fixture', () => {
  const names = tables.map((entry) => entry.name);

  assert.equal(
    names.filter((name) => !name.startsWith('to-dataframe')).length,
    14,
  );
  assert.ok(names.includes('to-dataframe empty'));
  assert.equal(tables.length, 145);
});
