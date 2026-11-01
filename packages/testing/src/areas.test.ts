import assert from 'node:assert/strict';
import { test } from 'node:test';

import spawn, { SubprocessError } from 'nano-spawn';

import { notInstalled } from './preload/index.ts';

/**
 * A consumer installs only the drivers of the areas it imports: the four
 * drivers are optional peers, and the mariadb and mysql2 drivers of this
 * package's own tests are no dependency at all. The child sees each hidden
 * driver as not installed, the way a consumer without it sees the package.
 */
const importArea = (area: string, hidden: [string, ...string[]]) =>
  spawn(process.execPath, [
    '--import',
    notInstalled(...hidden),
    '--input-type=module',
    '--eval',
    `await import('@zukhruf/testing/${area}');`,
  ]);

const drivers: [string, ...string[]] = [
  'mssql',
  '@duckdb/node-api',
  '@google-cloud/bigquery',
  'mariadb',
  'mysql2',
  'msw',
];

test('every area without a driver imports when no driver is installed', async () => {
  for (const area of [
    'node',
    'async',
    'docker',
    'postgres',
    'mysql',
    'mariadb',
    'clickhouse',
    'sqlite',
    'http',
    'streams',
    'fs',
    'preload',
  ]) {
    await importArea(area, drivers);
  }
});

test('an area with a driver needs only its own driver', async () => {
  for (const [area, driver] of [
    ['sqlserver', 'mssql'],
    ['duckdb', '@duckdb/node-api'],
    ['bigquery', '@google-cloud/bigquery'],
    ['msw', 'msw'],
  ] as const) {
    const [other, ...others] = drivers.filter((name) => name !== driver);
    assert.ok(other !== undefined);
    await importArea(area, [other, ...others]);
    await assert.rejects(
      importArea(area, [driver]),
      (error: unknown) =>
        error instanceof SubprocessError &&
        error.stderr.includes(`Cannot find package '${driver}'`),
    );
  }
});
