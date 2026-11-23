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

test('a consumer imports the package by its name, and the package has no runtime dependency', async () => {
  // Act
  const result = await run(`
    const { ModelMismatchError, VectorMissingError } = await import('@zukhruf/retrieval');
    const { default: manifest } = await import('@zukhruf/retrieval/package.json', { with: { type: 'json' } });
    console.log(JSON.stringify({
      modelMismatch: new ModelMismatchError(
        { provider: 'openai', modelId: 'a', dimensions: 1 },
        { provider: 'openai', modelId: 'b', dimensions: 1 },
      ).name,
      vectorMissing: new VectorMissingError('p').name,
      dependencies: Object.keys(manifest.dependencies ?? {}),
    }));
  `);

  // Assert
  assert.deepEqual(result, {
    modelMismatch: 'ModelMismatchError',
    vectorMissing: 'VectorMissingError',
    dependencies: [],
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
  assert.ok(
    specifiers.has('./model-mismatch-error.js'),
    'the scan found no imports',
  );
  assert.deepEqual(
    [...specifiers].filter(
      (specifier) =>
        !specifier.startsWith('node:') && !specifier.startsWith('./'),
    ),
    [],
  );
});
