import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { notInstalled } from '@zukhruf/testing/preload';

const execFileAsync = promisify(execFile);

// The third-party dependencies of a family are optional peers (ADR 0001,
// rule 3), so a user of another import path does not install them. The
// child sees each hidden package as not installed, as such a user sees the
// package.
const importPath = (path: string, hidden: readonly string[]) =>
  execFileAsync(process.execPath, [
    ...hidden.flatMap((name) => ['--import', notInstalled(name)]),
    '--input-type=module',
    '--eval',
    `await import('${path}');`,
  ]);

const peers = {
  '@zukhruf/evals/structured': ['@cfworker/json-schema', 'munkres'],
  '@zukhruf/evals/classification': ['@stdlib/blas-ext-base-gsumpw'],
};
const allPeers = Object.values(peers).flat();

test('the core imports when no peer of a family is installed', async () => {
  await importPath('@zukhruf/evals', allPeers);
});

test('./promptfoo imports when no peer of a family is installed', async () => {
  await importPath('@zukhruf/evals/promptfoo', allPeers);
});

for (const [path, own] of Object.entries(peers)) {
  test(`${path} imports with its peers and without the peers of the other family, and needs each one of its own`, async () => {
    await importPath(
      path,
      allPeers.filter((peer) => !own.includes(peer)),
    );
    for (const peer of own) {
      await assert.rejects(
        importPath(path, [peer]),
        (error: unknown) =>
          error instanceof Error &&
          'stderr' in error &&
          String(error.stderr).includes(`Cannot find package '${peer}'`),
      );
    }
  });
}
