import assert from 'node:assert/strict';
import { test } from 'node:test';

import spawn, { SubprocessError } from 'nano-spawn';

/**
 * A consumer installs only the drivers of the areas it imports: the three
 * drivers are optional peers. This child-process hook makes each driver
 * unresolvable, the way a consumer without it sees the package.
 */
const withoutDrivers = (drivers: string[]): string[] => [
  '--import',
  `data:text/javascript,${encodeURIComponent(`
    import { registerHooks } from 'node:module';
    const missing = new Set(${JSON.stringify(drivers)});
    registerHooks({
      resolve(specifier, context, next) {
        if (missing.has(specifier)) throw new Error('not installed: ' + specifier);
        return next(specifier, context);
      },
    });
  `)}`,
];

const importArea = (area: string, drivers: string[]) =>
  spawn(process.execPath, [
    ...withoutDrivers(drivers),
    '--input-type=module',
    '--eval',
    `await import('@zukhruf/testing/${area}');`,
  ]);

const drivers = ['mssql', '@duckdb/node-api', '@google-cloud/bigquery'];

test('every area without a driver imports when no driver is installed', async () => {
  for (const area of [
    'async',
    'docker',
    'postgres',
    'mysql',
    'clickhouse',
    'sqlite',
    'http',
    'streams',
  ]) {
    await importArea(area, drivers);
  }
});

test('an area with a driver needs only its own driver', async () => {
  for (const [area, driver] of [
    ['sqlserver', 'mssql'],
    ['duckdb', '@duckdb/node-api'],
    ['bigquery', '@google-cloud/bigquery'],
  ] as const) {
    await importArea(
      area,
      drivers.filter((other) => other !== driver),
    );
    await assert.rejects(
      importArea(area, [driver]),
      (error: unknown) =>
        error instanceof SubprocessError &&
        error.stderr.includes(`not installed: ${driver}`),
    );
  }
});
