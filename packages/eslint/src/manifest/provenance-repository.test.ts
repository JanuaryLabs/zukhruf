import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { describe, test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const URL = 'https://github.com/fx/fx';

/** Lints `file` of a workspace whose root package.json is `root` and whose `libs/greet/package.json` is `greet`, with `manifest/recommended`. */
async function lintWorkspace(
  file: 'package.json' | 'libs/greet/package.json',
  root: Record<string, unknown>,
  greet: Record<string, unknown>,
) {
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'package.json': JSON.stringify({ name: 'fx', ...root }),
    'eslint.config.mjs': fixtureConfig(`{
      plugins: { manifest },
      extends: ['manifest/recommended'],
    }`),
    'libs/greet/package.json': JSON.stringify({
      name: '@fx/greet',
      version: '0.0.0',
      ...greet,
    }),
  });
  return await lint(workspace.root, [file]);
}

/** Lints `libs/greet/package.json`, a project below the workspace root, with `manifest/recommended`. */
async function lintManifest(manifest: Record<string, unknown>) {
  return lintWorkspace('libs/greet/package.json', { private: true }, manifest);
}

// Each test starts processes of its own over a workspace of its own, so the
// tests run at the same time, as many as this machine's processors.
describe(
  'provenance-repository',
  { concurrency: availableParallelism() },
  () => {
    test('a published manifest with no repository is reported with the folder its directory names', async () => {
      // Act
      const findings = await lintManifest({});

      // Assert
      assert.deepEqual(
        findings.map(({ ruleId }) => ruleId),
        ['manifest/provenance-repository'],
      );
      assert.match(findings[0]?.message ?? '', /has no "repository"/);
      assert.match(findings[0]?.message ?? '', /"directory": "libs\/greet"/);
    });

    test('a published manifest whose repository url is empty is reported, because npm provenance compares it with the workflow repository', async () => {
      // Act
      const findings = await lintManifest({
        repository: { type: 'git', url: '', directory: 'libs/greet' },
      });

      // Assert
      assert.deepEqual(
        findings.map(({ ruleId }) => ruleId),
        ['manifest/provenance-repository'],
      );
      assert.match(findings[0]?.message ?? '', /no non-empty "url"/);
    });

    test('a published manifest whose repository has no url is reported', async () => {
      // Act
      const findings = await lintManifest({
        repository: { type: 'git', directory: 'libs/greet' },
      });

      // Assert
      assert.deepEqual(
        findings.map(({ ruleId }) => ruleId),
        ['manifest/provenance-repository'],
      );
      assert.match(findings[0]?.message ?? '', /no non-empty "url"/);
    });

    test('a published manifest below the workspace root whose repository has no directory is reported', async () => {
      // Act
      const findings = await lintManifest({
        repository: { type: 'git', url: URL },
      });

      // Assert
      assert.deepEqual(
        findings.map(({ ruleId }) => ruleId),
        ['manifest/provenance-repository'],
      );
      assert.match(
        findings[0]?.message ?? '',
        /"repository\.directory" is missing, but this package\.json is in "libs\/greet"/,
      );
    });

    test('a published manifest below the workspace root whose repository directory names another folder is reported', async () => {
      // Act
      const findings = await lintManifest({
        repository: { type: 'git', url: URL, directory: 'libs/other' },
      });

      // Assert
      assert.deepEqual(
        findings.map(({ ruleId }) => ruleId),
        ['manifest/provenance-repository'],
      );
      assert.match(findings[0]?.message ?? '', /is "libs\/other"/);
    });

    test('a published manifest whose repository names a url and its own folder is not reported', async () => {
      // Act
      const findings = await lintManifest({
        repository: { type: 'git', url: URL, directory: 'libs/greet' },
      });

      // Assert
      assert.deepEqual(findings, []);
    });

    test('a private manifest with no repository is not reported, because npm does not publish it', async () => {
      // Act
      const findings = await lintManifest({ private: true });

      // Assert
      assert.deepEqual(findings, []);
    });

    test('a manifest with no name is not reported, because npm does not publish it', async () => {
      // Act
      const findings = await lintManifest({ name: undefined });

      // Assert
      assert.deepEqual(findings, []);
    });

    test('a manifest with no version is not reported, because npm does not publish it', async () => {
      // Act
      const findings = await lintManifest({ version: undefined });

      // Assert
      assert.deepEqual(findings, []);
    });

    test('a manifest with neither name nor version is not reported, because npm does not publish it', async () => {
      // Act
      const findings = await lintManifest({
        name: undefined,
        version: undefined,
      });

      // Assert
      assert.deepEqual(findings, []);
    });

    test('a published workspace root whose repository is a url string is not reported, because npm publish turns it into an object', async () => {
      // Act
      const findings = await lintWorkspace(
        'package.json',
        { version: '0.0.0', repository: URL },
        { private: true },
      );

      // Assert
      assert.deepEqual(findings, []);
    });

    test('a published workspace root whose repository is an empty string is reported', async () => {
      // Act
      const findings = await lintWorkspace(
        'package.json',
        { version: '0.0.0', repository: '' },
        { private: true },
      );

      // Assert
      assert.deepEqual(
        findings.map(({ ruleId }) => ruleId),
        ['manifest/provenance-repository'],
      );
      assert.match(findings[0]?.message ?? '', /no non-empty "url"/);
    });
  },
);
