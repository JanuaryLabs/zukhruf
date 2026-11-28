import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import { Command } from '@zukhruf/process';

const pluginEntry = fileURLToPath(import.meta.resolve('@zukhruf/nx/test'));
// The script that the test target runs, next to the plugin.
const runner = join(dirname(pluginEntry), `run${extname(pluginEntry)}`);

// The test process of Node 26 ends with exit code 1 at SIGINT and SIGTERM,
// after it printed which tests it interrupted, and SIGHUP kills it (probed
// 2026-11-28).
void test.each(
  [
    ['SIGINT', { exitCode: 1 }, true],
    ['SIGTERM', { exitCode: 1 }, true],
    ['SIGHUP', { signal: 'SIGHUP' }, false],
  ] as const,
  ([signal, end, interrupted]) =>
    test(`a ${signal} to the runner reaches the test process, and the runner ends as that process ended`, async (t) => {
      await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
      await mkdir(join(folder.path, 'src'));
      await writeFile(
        join(folder.path, 'src/waits.test.mjs'),
        "import { test } from 'node:test';\ntest('waits', async () => { console.log('running'); await new Promise((resolve) => setTimeout(resolve, 60_000)); });\n",
      );
      await using run = await new Command(
        process.execPath,
        [
          runner,
          '--test',
          '--test-reporter=spec',
          '--selection=src/**/*.test.mjs',
        ],
        // Without NODE_TEST_CONTEXT of the test that runs this one: with it,
        // the test process would run no file.
        {
          cwd: folder.path,
          env: { ...process.env, NODE_TEST_CONTEXT: undefined },
          clock: globalThis,
        },
      ).start({ ready: { line: 'running' }, signal: t.signal });

      run.signal(signal);
      // The spec reporter colours its lines when the environment has FORCE_COLOR.
      const lines = (await Array.fromAsync(run.lines())).map((line) =>
        stripVTControlCharacters(line),
      );

      assert.deepEqual(await run.ended, end);
      assert.equal(
        lines.includes('Interrupted while running:'),
        interrupted,
        lines.join('\n'),
      );
    }),
);
