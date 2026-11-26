import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe } from 'node:test';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/fs';
import { Launchd } from '@zukhruf/launchd';
import { test } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';

import { Client } from './index.ts';

const run = promisify(execFile);

// An app bundle whose main executable is a clone of this Node binary. A
// script would run as /bin/sh, and macOS refuses to launch a copy of an Apple
// binary such as /bin/sleep outside its path (launch constraints, macOS 13).
async function app(folder: string): Promise<string> {
  await mkdir(join(folder, 'Contents', 'MacOS'), { recursive: true });
  await copyFile(
    process.execPath,
    join(folder, 'Contents', 'MacOS', 'probe'),
    constants.COPYFILE_FICLONE,
  );
  await writeFile(
    join(folder, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>probe</string>
<key>CFBundleIdentifier</key><string>com.zukhruf.tcc.probe</string>
<key>CFBundleName</key><string>Probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
`,
  );
  return join(folder, 'Contents', 'MacOS', 'probe');
}

describe('the client of a process', () => {
  test('a process that has ended has no client', async () => {
    // Arrange
    const child = spawn(process.execPath, ['--eval', '']);
    await once(child, 'exit');
    const { pid } = child;
    assert.ok(pid !== undefined);

    // Act and assert
    assert.throws(() => Client.responsibleFor(pid), RangeError);
  });

  test('a process that launchd starts is its own client, an executable', async (t) => {
    // Arrange
    const launchd = Launchd.agents({ clock: globalThis });
    const service = launchd.service('com.zukhruf.tcc.responsible-client');

    try {
      await launchd.install({
        Label: service.label,
        ProgramArguments: ['/bin/sleep', '600'],
        RunAtLoad: true,
      });
      // launchd starts the job through xpcproxy, which then runs the program
      // in the same process: wait until ps shows /bin/sleep there.
      const { pid } = await waitFor(
        async () => {
          const state = await service.state();
          assert.equal(state.state, 'running');
          const { stdout } = await run('/bin/ps', [
            '-o',
            'comm=',
            '-p',
            String(state.pid),
          ]);
          assert.equal(stdout.trim(), '/bin/sleep');
          return state;
        },
        { signal: t.signal, interval: 100 },
      );

      // Act
      const client = Client.responsibleFor(pid);

      // Assert
      assert.deepEqual(
        { type: client.type, path: client.path, name: client.name },
        { type: 'executable', path: '/bin/sleep', name: '/bin/sleep' },
      );
    } finally {
      await service.uninstall();
    }
  });

  void test.each(
    [
      { case: 'an app', folders: ['Probe.app'] },
      {
        case: 'an app inside the folder of another app',
        folders: ['Outer.app', 'Contents', 'Helpers', 'Probe.app'],
      },
    ],
    (row) =>
      test(`${row.case} that LaunchServices opens is its own client, a bundle`, async (t) => {
        // Arrange
        await using scratch = await new TemporaryFiles().directory('tcc-');
        const bundle = join(await realpath(scratch.path), ...row.folders);
        const executable = await app(bundle);
        await run('/usr/bin/open', [
          '-g',
          '-n',
          bundle,
          '--args',
          '--eval',
          'setTimeout(() => {}, 600_000)',
        ]);
        const pid = await waitFor(
          async () => {
            const { stdout } = await run('/usr/bin/pgrep', ['-f', executable]);
            return Number(stdout.trim());
          },
          { signal: t.signal, interval: 100 },
        );

        try {
          // Act
          const client = Client.responsibleFor(pid);

          // Assert
          assert.deepEqual(
            { type: client.type, path: client.path, name: client.name },
            { type: 'bundle', path: bundle, name: 'Probe' },
          );
        } finally {
          process.kill(pid);
        }
      }),
  );

  test('a process that an app starts has the app as its client', async (t) => {
    // Arrange: the app starts /bin/sleep and writes its pid to a file.
    await using scratch = await new TemporaryFiles().directory('tcc-');
    const folder = await realpath(scratch.path);
    const bundle = join(folder, 'Probe.app');
    const executable = await app(bundle);
    const pidFile = join(folder, 'child.pid');
    await run('/usr/bin/open', [
      '-g',
      '-n',
      bundle,
      '--args',
      '--eval',
      `const child = require('node:child_process').spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
require('node:fs').writeFileSync(process.argv[1], String(child.pid));
setTimeout(() => {}, 600_000);`,
      pidFile,
    ]);
    const parent = await waitFor(
      async () =>
        Number((await run('/usr/bin/pgrep', ['-f', executable])).stdout.trim()),
      { signal: t.signal, interval: 100 },
    );
    const child = await waitFor(
      async () => {
        const pid = Number(await readFile(pidFile, 'utf8'));
        assert.ok(pid > 0);
        return pid;
      },
      { signal: t.signal, interval: 100 },
    );

    try {
      // Act
      const client = Client.responsibleFor(child);

      // Assert
      assert.deepEqual(
        { type: client.type, path: client.path, name: client.name },
        { type: 'bundle', path: bundle, name: 'Probe' },
      );
    } finally {
      process.kill(child);
      process.kill(parent);
    }
  });
});
