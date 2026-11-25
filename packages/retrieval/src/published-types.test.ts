import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const root = join(import.meta.dirname, '..');
const fixture = join(root, 'type-tests');

/**
 * Compiles type-tests with the TypeScript that builds the package. The test
 * target builds dist first, so the fixture reads the declarations a consumer
 * installs, not src: declaration emit writes a private field without its
 * type, so a class can be sound in src and unsound in dist.
 */
const compile = async (): Promise<string> => {
  const tsc = join(
    dirname(
      createRequire(import.meta.url).resolve('@typescript/native/package.json'),
    ),
    'bin',
    'tsc',
  );
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [tsc, '--project', fixture, '--pretty', 'false', '--listFiles'],
      { cwd: root },
    );
    return stdout;
  } catch (error) {
    // tsc exits non-zero when it reports an error, as the fixture expects.
    if (Error.isError(error) && 'stdout' in error) return String(error.stdout);
    throw error;
  }
};

test('a consumer of the built declarations gets exactly the errors marked in type-tests: a host-typed FusionRetriever or PostprocessingRetriever does not widen to a plain one, the weights of a fusion take only the names of its retrievers and its record holds at least one name and none with a colon, the passage type keeps live passages from stored ones and checks the metadata and the filter, and the built-in postprocessors and fusions take the passage type of the retriever while a host postprocessor or fusion of one passage type needs no assertion, and every async port takes signal, not abortSignal, and each keyword retriever takes only the matching of its own engine, with no operator and no contradictory combination, and a score threshold is an option of each embedding retriever and of Rerank, never of a call', async () => {
  // Arrange
  const source = await readFile(join(fixture, 'published-types.ts'), 'utf8');
  const expected = source
    .split('\n')
    .flatMap((line, index) =>
      [...line.matchAll(/\/\/ (TS\d+)$/g)].map(
        ([, code]) => `type-tests/published-types.ts:${index + 1} ${code}`,
      ),
    );

  // Act
  const stdout = await compile();

  // Assert
  // Every error tsc reports, in any file or in none.
  const errors = [
    ...stdout.matchAll(/^(?:(.+?)\((\d+),\d+\): )?error (TS\d+):/gm),
  ].map(([, file = '', line = '', error]) => `${file}:${line} ${error}`);
  const files = stdout.split('\n').filter((line) => line.startsWith(root));
  assert.equal(expected.length, 48, 'the fixture marks its 48 errors');
  assert.deepEqual(errors, expected);
  assert.ok(files.includes(join(root, 'dist', 'index.d.ts')));
  assert.deepEqual(
    files.filter((file) => file.startsWith(join(root, 'src'))),
    [],
  );
});
