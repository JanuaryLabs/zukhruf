import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';
import { Command, ExitError } from '@zukhruf/process';

import { notInstalled } from './preload/index.ts';

/**
 * A consumer installs only the drivers of the areas it imports: each driver
 * is an optional peer. The child sees each hidden driver as not installed,
 * the way a consumer without it sees the package.
 */
async function importArea(
  area: string,
  hidden: [string, ...string[]],
): Promise<void> {
  const run = await new Command(
    process.execPath,
    [
      '--import',
      notInstalled(...hidden),
      '--input-type=module',
      '--eval',
      `await import('@zukhruf/testing/${area}');`,
    ],
    { env: process.env, clock: globalThis },
  ).run();
  if (run.exitCode !== 0)
    throw new ExitError(`the import of @zukhruf/testing/${area}`, run);
}

const drivers: [string, ...string[]] = [
  'mssql',
  '@duckdb/node-api',
  '@google-cloud/bigquery',
  'mariadb',
  'mysql2',
  'pg',
  'msw',
];

void test.each(
  [
    'async',
    'process',
    'docker',
    'clickhouse',
    'sqlite',
    'http',
    'streams',
    'preload',
  ],
  (area) =>
    test(`the ${area} area, which has no driver, imports when no driver is installed`, async () => {
      await importArea(area, drivers);
    }),
);

void test.each(
  [
    ['sqlserver', 'mssql'],
    ['postgres', 'pg'],
    ['mysql', 'mysql2'],
    ['mariadb', 'mariadb'],
    ['duckdb', '@duckdb/node-api'],
    ['bigquery', '@google-cloud/bigquery'],
    ['msw', 'msw'],
  ] as const,
  ([area, driver]) =>
    test(`the ${area} area needs only its own driver, ${driver}`, async () => {
      // Arrange
      const [other, ...others] = drivers.filter((name) => name !== driver);
      assert.ok(other !== undefined);

      // Act and Assert
      await importArea(area, [other, ...others]);
      await assert.rejects(
        importArea(area, [driver]),
        (error: unknown) =>
          Error.isError(error) &&
          'stderr' in error &&
          String(error.stderr).includes(`Cannot find package '${driver}'`),
      );
    }),
);
