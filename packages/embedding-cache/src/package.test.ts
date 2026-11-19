import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
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

test('a consumer imports each subpath by its package name, and the package has no runtime dependency on ai', async () => {
  // Act
  const result = await run(`
    const { embeddingCacheMiddleware, MemoryEmbeddingCacheStore } = await import('@zukhruf/embedding-cache');
    const { SqliteEmbeddingCacheStore } = await import('@zukhruf/embedding-cache/sqlite');
    const { SqlServerEmbeddingCacheStore } = await import('@zukhruf/embedding-cache/sqlserver');
    const { default: manifest } = await import('@zukhruf/embedding-cache/package.json', { with: { type: 'json' } });
    console.log(JSON.stringify({
      middleware: embeddingCacheMiddleware({ store: new MemoryEmbeddingCacheStore() }).specificationVersion,
      sqlite: typeof SqliteEmbeddingCacheStore,
      sqlserver: typeof SqlServerEmbeddingCacheStore,
      dependencies: Object.keys(manifest.dependencies ?? {}),
    }));
  `);

  // Assert
  assert.deepEqual(result, {
    middleware: 'v4',
    sqlite: 'function',
    sqlserver: 'function',
    dependencies: ['@ai-sdk/provider'],
  });
});

test('the built package imports only node built-ins and its own files at run time', async () => {
  // Arrange
  const dist = join(import.meta.dirname, '..', 'dist');
  const files = (await readdir(dist)).filter((file) => file.endsWith('.js'));

  // Act
  const specifiers = new Set<string>();
  for (const file of files) {
    const source = await readFile(join(dist, file), 'utf8');
    for (const match of source.matchAll(
      /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g,
    ))
      specifiers.add(match[1] ?? '');
  }

  // Assert
  assert.ok(specifiers.has('node:crypto'), 'the scan found no imports');
  assert.deepEqual(
    [...specifiers].filter(
      (specifier) =>
        !specifier.startsWith('node:') && !specifier.startsWith('./'),
    ),
    [],
  );
});
