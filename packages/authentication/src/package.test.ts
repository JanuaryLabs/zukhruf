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

test('a consumer imports each subpath by its package name, and the package has no root export and no runtime dependency', async () => {
  // Act
  const result = await run(`
    const hono = await import('@zukhruf/authentication/hono');
    const router = await import('@zukhruf/authentication/react-router');
    const { default: manifest } = await import('@zukhruf/authentication/package.json', { with: { type: 'json' } });
    let root = 'importable';
    try { await import('@zukhruf/authentication'); } catch (error) { root = error.code; }
    console.log(JSON.stringify({
      honoMissing: ['TwoFactorRequiredError', 'UnauthenticatedError', 'requireSession'].filter((name) => !(name in hono)),
      routerMissing: ['AuthenticationUnavailableError', 'REDIRECT_TO', 'requireSession', 'safeRedirect'].filter((name) => !(name in router)),
      root,
      dependencies: Object.keys(manifest.dependencies ?? {}),
      optionalPeers: Object.keys(manifest.peerDependenciesMeta ?? {}).filter((name) => manifest.peerDependenciesMeta[name].optional),
    }));
  `);

  // Assert
  assert.deepEqual(result, {
    honoMissing: [],
    routerMissing: [],
    root: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    dependencies: [],
    optionalPeers: ['hono', 'react-router'],
  });
});

test('each built subpath imports only its own framework, and nothing from better-auth', async () => {
  // Arrange
  const dist = join(import.meta.dirname, '..', 'dist');
  const files = (await readdir(dist)).filter((file) => file.endsWith('.js'));

  // Act
  const imports: Record<string, string[]> = {};
  for (const file of files) {
    const source = await readFile(join(dist, file), 'utf8');
    imports[file] = [
      ...source.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g),
    ]
      .map((match) => match[1] ?? '')
      .sort();
  }

  // Assert
  const packages = (file: string) =>
    (imports[file] ?? []).map((specifier) => specifier.split('/')[0]);
  assert.ok(packages('hono.js').includes('hono'), 'the scan found no imports');
  assert.ok(packages('react-router.js').includes('react-router'));
  assert.deepEqual(
    packages('hono.js').filter((name) => name !== 'hono'),
    [],
  );
  assert.deepEqual(
    packages('react-router.js').filter((name) => name !== 'react-router'),
    [],
  );
});
