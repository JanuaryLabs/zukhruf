import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TemporaryFiles } from '@zukhruf/fs';

// The dokploy-stack OpenTofu module that each Dokploy host calls at ref=main
// (ADR 0015). Its own tests are the .tftest.hcl files beside it; this test
// runs them on a copy, so tofu init writes nothing into the source tree.
const moduleFolder = fileURLToPath(
  new URL('../../opentofu/dokploy-stack', import.meta.url),
);

const tofuOnPath =
  spawnSync('tofu', ['version'], { stdio: 'ignore' }).status === 0;

test(
  'the dokploy-stack module is formatted, validates and passes its tofu tests',
  { skip: tofuOnPath ? false : 'tofu is not on PATH' },
  async () => {
    await using folder = await new TemporaryFiles().directory(
      'zukhruf-dokploy-stack-',
    );
    const copy = join(folder.path, 'dokploy-stack');
    await cp(moduleFolder, copy, {
      recursive: true,
      filter: (source) => !source.includes('.terraform'),
    });

    for (const args of [
      ['fmt', '-check', '-diff', '-recursive'],
      ['init', '-input=false', '-no-color'],
      ['validate', '-no-color'],
      ['test', '-no-color'],
    ]) {
      const run = spawnSync('tofu', args, { cwd: copy, encoding: 'utf8' });

      assert.equal(
        run.status,
        0,
        `tofu ${args.join(' ')}\n${run.stdout}${run.stderr}`,
      );
    }
  },
);
