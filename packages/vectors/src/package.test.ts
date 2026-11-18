import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

/**
 * A consumer imports the package by its name, so this test does too: a child
 * process resolves each path through the exports of package.json, the way an
 * installed copy resolves it.
 */
const run = async (source: string): Promise<unknown> => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '--eval',
    source,
  ]);
  return JSON.parse(stdout);
};

test('a consumer imports each subpath by its package name, and the package has no dependencies', async () => {
  // Act
  const result = await run(`
    const { Vector } = await import('@zukhruf/vectors');
    const sqlite = await import('@zukhruf/vectors/sqlite');
    const sqlserver = await import('@zukhruf/vectors/sqlserver');
    const { default: manifest } = await import('@zukhruf/vectors/package.json', { with: { type: 'json' } });
    const vector = Vector.from([1, 2]);
    console.log(JSON.stringify({
      dimensions: sqlite.fromSql(Vector, sqlite.toSql(vector)).dimensions,
      sqlType: sqlserver.sqlType(vector),
      install: typeof sqlite.install,
      dependencies: 'dependencies' in manifest,
    }));
  `);

  // Assert
  assert.deepEqual(result, {
    dimensions: 2,
    sqlType: 'VECTOR(2)',
    install: 'function',
    dependencies: false,
  });
});
