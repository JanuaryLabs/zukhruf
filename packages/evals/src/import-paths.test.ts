import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { notInstalled } from '@zukhruf/testing/preload';

const execFileAsync = promisify(execFile);

// The third-party dependencies of ./structured are optional peers (ADR 0001,
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

const structuredPeers = ['@cfworker/json-schema', 'munkres'];

test('the core imports when the peers of ./structured are not installed', async () => {
  await importPath('@zukhruf/evals', structuredPeers);
});

test('./promptfoo imports when the peers of ./structured are not installed', async () => {
  await importPath('@zukhruf/evals/promptfoo', structuredPeers);
});

test('./structured imports with its peers, and needs each one of them', async () => {
  await importPath('@zukhruf/evals/structured', []);
  for (const peer of structuredPeers) {
    await assert.rejects(
      importPath('@zukhruf/evals/structured', [peer]),
      (error: unknown) =>
        error instanceof Error &&
        'stderr' in error &&
        String(error.stderr).includes(`Cannot find package '${peer}'`),
    );
  }
});
