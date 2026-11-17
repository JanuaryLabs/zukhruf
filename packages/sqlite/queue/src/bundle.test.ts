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
    await using folder = await new TemporaryFiles().directory('queue-bundle-');
    const outfile = join(folder.path, 'dist', 'main.mjs');
    await build({
      entryPoints: [
        fileURLToPath(import.meta.resolve('@zukhruf/sqlite-queue')),
      ],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
      // pg-boss requires CommonJS modules, and an ES module has no require.
      // A host gives the bundle one, as context-compiler does.
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });

    const bundled = await import(pathToFileURL(outfile).href);

    assert.equal(typeof bundled.SqliteJobQueue, 'function');
  });
});
