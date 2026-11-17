import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/fs';

import { downloadHead, loadWeights, modelDirectory } from '../index.ts';

const REVISION = 'e618a6919e5a15c6ced46c9874424363c2955283';
// HEAD_SHA256 of venn/profiles.py: the digest of the venn-1 head.
const HEAD_SHA256 =
  '03c62c7fbc5f5d6b49e171084c9b64291a1201b4cf967b5abbc9ebcfa3137aa9';

test('downloadHead gives the venn-1 head at its commit, which modelDirectory and loadWeights read', async () => {
  await using cache = await new TemporaryFiles().directory(
    'vector-decisions-hub-',
  );

  const directory = await downloadHead({
    cacheDir: cache.path,
    clock: globalThis,
  });

  assert.equal(
    directory,
    join(
      cache.path,
      'models--markrussinovich--venn-1',
      'snapshots',
      REVISION,
      'assets',
    ),
  );
  const manifest: { readonly sha256: Readonly<Record<string, string>> } =
    JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sha256['universal.safetensors'], HEAD_SHA256);
  const weights = await loadWeights(
    join(await modelDirectory(directory), 'universal.safetensors'),
  );
  assert.equal(weights.get('temperature')?.values[0], 0.06702037900686264);
  const parameters = [...weights]
    .filter(([name]) => name !== 'temperature' && name !== 'none_intercept')
    .reduce((count, [, tensor]) => count + tensor.values.length, 0);
  assert.equal(parameters, 787_457);
});

test('a second downloadHead with the same cache needs no network', async () => {
  await using cache = await new TemporaryFiles().directory(
    'vector-decisions-hub-',
  );
  const first = await downloadHead({ cacheDir: cache.path, clock: globalThis });

  // Without --allow-net, the permission model of Node refuses each network
  // call with ERR_ACCESS_DENIED.
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--permission',
    '--allow-fs-read=*',
    `--allow-fs-write=${cache.path}`,
    '--input-type=module',
    '--eval',
    `import { downloadHead } from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)};
process.stdout.write(await downloadHead({ cacheDir: process.argv[1], clock: globalThis }));`,
    cache.path,
  ]);

  assert.equal(stdout, first);
});

// @huggingface/hub 2.17.11 downloads each file into one "<blob>.incomplete"
// for every process, so a second process lost the file that the first had
// renamed (#4457).
test('four processes that download the head at once into one empty cache each give the head, whose files match their digests', async () => {
  await using cache = await new TemporaryFiles().directory(
    'vector-decisions-hub-',
  );
  const download = () =>
    promisify(execFile)(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { downloadHead, modelDirectory } from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)};
process.stdout.write(await modelDirectory(await downloadHead({ cacheDir: process.argv[1], clock: globalThis })));`,
      cache.path,
    ]);

  const outputs = await Promise.all([
    download(),
    download(),
    download(),
    download(),
  ]);

  assert.deepEqual(
    outputs.map(({ stdout }) => stdout.split('\n').at(-1)),
    Array(4).fill(
      join(
        cache.path,
        'models--markrussinovich--venn-1',
        'snapshots',
        REVISION,
        'assets',
      ),
    ),
  );
});
