import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { TemporaryFiles } from '@zukhruf/fs';

import manifest from '../package.json' with { type: 'json' };

describe('a bundle that holds this plugin', () => {
  // A host bundles its ESLint config with the plugin into its own package
  // and keeps the plugin's dependencies in its node_modules. The package.json
  // above the bundle is the host's, not this package's (#4517).
  it("reports the version of @zukhruf/eslint, not the host's", async () => {
    await using host = await new TemporaryFiles().directory('eslint-bundle-');
    await writeFile(
      join(host.path, 'package.json'),
      JSON.stringify({ name: 'host', version: '9.9.9', type: 'module' }),
    );
    await symlink(
      fileURLToPath(new URL('../../../node_modules', import.meta.url)),
      join(host.path, 'node_modules'),
    );
    await mkdir(join(host.path, 'dist'));
    const outfile = join(host.path, 'dist', 'eslint.config.js');
    await build({
      entryPoints: [fileURLToPath(import.meta.resolve('@zukhruf/eslint'))],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      packages: 'external',
      logLevel: 'silent',
    });

    const bundled = await import(pathToFileURL(outfile).href);

    assert.equal(bundled.default.meta.version, manifest.version);
  });
});
