import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { TemporaryFiles } from '@zukhruf/fs';

describe('a bundle that holds this package', () => {
  // A host bundles its program, as context-compiler bundles its MCP server
  // with @zukhruf/pool, and runs the bundle from a folder of its own. No
  // package.json of this package is beside the bundle (#4516).
  it('loads in a folder with no package.json', async () => {
    await using folder = await new TemporaryFiles().directory('notify-bundle-');
    const outfile = join(folder.path, 'dist', 'main.mjs');
    await build({
      entryPoints: [
        fileURLToPath(import.meta.resolve('@zukhruf/sqlite-notify')),
      ],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
    });

    const bundled = await import(pathToFileURL(outfile).href);

    assert.equal(typeof bundled.Notifications, 'function');
  });
});
