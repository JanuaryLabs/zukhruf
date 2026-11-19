import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

/** The `repository` that `manifest/provenance-repository` requires of a published manifest in `libs/greet`. */
const REPOSITORY = {
  type: 'git',
  url: 'https://github.com/fx/fx',
  directory: 'libs/greet',
};

/** Lints `libs/greet/package.json`, whose text is `source`, with `manifest/recommended` and returns its findings. */
async function lintManifestSource(source: string) {
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'package.json': JSON.stringify({ name: 'fx', private: true }),
    'eslint.config.mjs': fixtureConfig(`{
      plugins: { manifest },
      extends: ['manifest/recommended'],
    }`),
    'libs/greet/package.json': source,
  });
  return lint(workspace.root, ['libs/greet/package.json']);
}

/** Lints `libs/greet/package.json` with `manifest/recommended` and returns its findings. */
async function lintManifest(manifest: Record<string, unknown>) {
  return lintManifestSource(
    JSON.stringify({
      name: '@fx/greet',
      version: '0.0.0',
      repository: REPOSITORY,
      ...manifest,
    }),
  );
}

test('a published manifest whose description is longer than 255 characters is reported with its length and the limit', async () => {
  // Arrange
  const description = 'a'.repeat(256);

  // Act
  const findings = await lintManifest({ description });

  // Assert
  assert.deepEqual(
    findings.map(({ ruleId }) => ruleId),
    ['manifest/no-truncated-description'],
  );
  assert.match(findings[0]?.message ?? '', /\b256 characters\b/);
  assert.match(findings[0]?.message ?? '', /\bat most 255\b/);
});

test('a published manifest whose description has exactly 255 characters is not reported', async () => {
  // Arrange
  const description = 'a'.repeat(255);

  // Act
  const findings = await lintManifest({ description });

  // Assert
  assert.deepEqual(findings, []);
});

test('a private manifest is not reported, because npm does not publish it', async () => {
  // Arrange
  const description = 'a'.repeat(300);

  // Act
  const findings = await lintManifest({ private: true, description });

  // Assert
  assert.deepEqual(findings, []);
});

test('a manifest with two description keys is reported when the last one is longer than 255 characters, because JSON.parse keeps the last', async () => {
  // Arrange
  const source = `{"name":"@fx/greet","version":"0.0.0","repository":${JSON.stringify(REPOSITORY)},"description":"short","description":"${'a'.repeat(256)}"}`;

  // Act
  const findings = await lintManifestSource(source);

  // Assert
  assert.deepEqual(
    findings.map(({ ruleId }) => ruleId),
    ['manifest/no-truncated-description'],
  );
  assert.match(findings[0]?.message ?? '', /\b256 characters\b/);
});

test('a manifest with two description keys is not reported when the last one is short, because JSON.parse keeps the last', async () => {
  // Arrange
  const source = `{"name":"@fx/greet","version":"0.0.0","repository":${JSON.stringify(REPOSITORY)},"description":"${'a'.repeat(256)}","description":"short"}`;

  // Act
  const findings = await lintManifestSource(source);

  // Assert
  assert.deepEqual(findings, []);
});

test('a manifest with two private keys is reported when the last one is false, because npm publishes it', async () => {
  // Arrange
  const source = `{"name":"@fx/greet","version":"0.0.0","repository":${JSON.stringify(REPOSITORY)},"private":true,"private":false,"description":"${'a'.repeat(256)}"}`;

  // Act
  const findings = await lintManifestSource(source);

  // Assert
  assert.deepEqual(
    findings.map(({ ruleId }) => ruleId),
    ['manifest/no-truncated-description'],
  );
});
