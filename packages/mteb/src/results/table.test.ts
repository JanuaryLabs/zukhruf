import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify, stripVTControlCharacters } from 'node:util';

import { DataFrame } from '../dependencies/pandas.ts';

test('toString aligns the columns: text to the left, floats to the right with 6 decimals', () => {
  const table = new DataFrame(
    [
      ['task_name', ''],
      ['is_public', ''],
      ['org/model', 'r1'],
      ['org/model', 'r2'],
    ],
    [
      ['ArguAna', true, 0.5, NaN],
      ['SCIDOCS', false, 0.0344535, 12.25],
    ],
  );

  assert.equal(
    table.toString(),
    [
      'task_name  is_public  org/model  org/model',
      '                             r1         r2',
      'ArguAna    True        0.500000        NaN',
      'SCIDOCS    False       0.034453  12.250000',
    ].join('\n'),
  );
});

test('the table example prints a column and the means of each model and experiment of a cache folder', async () => {
  const root = join(import.meta.dirname, '../..');
  const folder = join(import.meta.dirname, 'fixtures/to-dataframe');

  const { stdout: output } = await promisify(execFile)(
    process.execPath,
    ['examples/table.ts', folder],
    { cwd: root },
  );

  // console.table colors the values when the environment asks for colors.
  const stdout = stripVTControlCharacters(output);
  const lines = stdout.split('\n');
  assert.deepEqual(lines.slice(0, 4), [
    'task_name  is_public  zukhruf/model-a  zukhruf/model-b  zukhruf/model-b  zukhruf/model-c',
    '                                                                 k1_1.2',
    'ArguAna    True              0.777635         0.200000         0.065912         0.996818',
    'SCIDOCS    True              0.340330         0.100000              NaN              NaN',
  ]);
  assert.match(
    stdout,
    /│ 'zukhruf\/model-b' │ '' +│ 0\.15000000000000002 │ 0\.15000000000000002 │/u,
  );
  assert.match(stdout, /│ 'zukhruf\/model-b' │ 'k1_1\.2' +│ null +│ null +│/u);
});
