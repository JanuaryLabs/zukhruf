import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';

import {
  type AgentJob,
  LaunchctlError,
  Launchd,
  PermissionDeniedError,
} from '../index.ts';

// The labels of this file. They are fixed, because launchd keeps the enable
// override of each label it saw, and the other test file has its own.
const PREFIX = 'dev.zukhruf.launchd.test.launchd.';

describe('Launchd', { concurrency: true }, () => {
  void test.each(['', '.', '..', 'a/b'], (label) =>
    test(`install refuses the label ${JSON.stringify(label)}, which is not one file name, before it writes a file`, async () => {
      // Arrange
      const launchd = Launchd.agents({ clock: globalThis });
      const file = join(launchd.folder, `${label}.plist`);
      await assert.rejects(stat(file), { code: 'ENOENT' });
      try {
        // Act
        const install = launchd.install({
          Label: label,
          ProgramArguments: ['/bin/sleep', '600'],
        });

        // Assert
        await assert.rejects(install, RangeError);
        assert.throws(() => launchd.service(label), RangeError);
        await assert.rejects(stat(file), { code: 'ENOENT' });
      } finally {
        // Absent before the test, so only a broken install made it.
        await rm(file, { force: true });
      }
    }),
  );

  test('install refuses a label with a NUL character', async () => {
    const launchd = Launchd.agents({ clock: globalThis });

    const install = launchd.install({
      Label: 'dev.zukhruf\0x',
      ProgramArguments: ['/bin/sleep', '600'],
    });

    await assert.rejects(install, RangeError);
    assert.throws(() => launchd.service('dev.zukhruf\0x'), RangeError);
  });

  test('install writes the job file with the keys of each dictionary sorted, with mode 0644, and loads it in the domain of the console owner', async () => {
    // Arrange
    const label = `${PREFIX}golden`;
    const launchd = Launchd.agents({ clock: globalThis });
    const service = launchd.service(label);
    try {
      // Act
      const installed = await launchd.install({
        StartCalendarInterval: [
          { Minute: 30, Hour: 3 },
          { Weekday: 0, Minute: 0, Hour: 12 },
        ],
        ProgramArguments: ['/bin/sh', '-c', 'exec /bin/sleep 600'],
        Label: label,
        EnvironmentVariables: { ZETA: 'last', ALPHA: 'first' },
        KeepAlive: {
          PathState: {
            '/var/empty/dev.zukhruf.launchd.test.b': true,
            '/var/empty/dev.zukhruf.launchd.test.a': true,
          },
          AfterInitialDemand: true,
        },
      });

      // Assert
      const { uid } = userInfo();
      const atConsole = (await stat('/dev/console')).uid === uid;
      assert.equal(launchd.domain, atConsole ? `gui/${uid}` : `user/${uid}`);
      assert.equal(launchd.folder, join(homedir(), 'Library/LaunchAgents'));
      assert.equal(installed.label, label);
      assert.equal(installed.target, `${launchd.domain}/${label}`);
      assert.equal(installed.file, join(launchd.folder, `${label}.plist`));
      assert.equal(
        await readFile(installed.file, 'utf8'),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>EnvironmentVariables</key>
    <dict>
      <key>ALPHA</key>
      <string>first</string>
      <key>ZETA</key>
      <string>last</string>
    </dict>
    <key>KeepAlive</key>
    <dict>
      <key>AfterInitialDemand</key>
      <true/>
      <key>PathState</key>
      <dict>
        <key>/var/empty/dev.zukhruf.launchd.test.a</key>
        <true/>
        <key>/var/empty/dev.zukhruf.launchd.test.b</key>
        <true/>
      </dict>
    </dict>
    <key>Label</key>
    <string>dev.zukhruf.launchd.test.launchd.golden</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/sh</string>
      <string>-c</string>
      <string>exec /bin/sleep 600</string>
    </array>
    <key>StartCalendarInterval</key>
    <array>
      <dict>
        <key>Hour</key>
        <integer>3</integer>
        <key>Minute</key>
        <integer>30</integer>
      </dict>
      <dict>
        <key>Hour</key>
        <integer>12</integer>
        <key>Minute</key>
        <integer>0</integer>
        <key>Weekday</key>
        <integer>0</integer>
      </dict>
    </array>
  </dict>
</plist>`,
      );
      assert.equal((await stat(installed.file)).mode & 0o777, 0o644);
      assert.notEqual((await installed.state()).state, 'not loaded');
    } finally {
      await service.uninstall();
    }
  });

  test('a second install of the same job keeps the process that runs', async (t) => {
    // Arrange
    const label = `${PREFIX}again`;
    const launchd = Launchd.agents({ clock: globalThis });
    const service = launchd.service(label);
    const job = {
      Label: label,
      ProgramArguments: ['/bin/sleep', '600'],
      RunAtLoad: true,
    } satisfies AgentJob;
    try {
      await launchd.install(job);
      const first = await waitFor(
        async () => {
          const state = await service.state();
          assert.ok(state.state === 'running', state.state);
          return state;
        },
        { signal: t.signal, interval: 100 },
      );

      // Act
      await launchd.install(job);

      // Assert
      assert.deepEqual(await service.state(), first);
    } finally {
      await service.uninstall();
    }
  });

  test('a second install of the same job keeps a loaded service whose process ended', async (t) => {
    // Arrange
    const label = `${PREFIX}again-ended`;
    const launchd = Launchd.agents({ clock: globalThis });
    const service = launchd.service(label);
    const job = {
      Label: label,
      ProgramArguments: ['/bin/sh', '-c', 'exit 3'],
      RunAtLoad: true,
    } satisfies AgentJob;
    try {
      await launchd.install(job);
      const ended = { state: 'not running', lastExitStatus: 3 } as const;
      await waitFor(
        async () => {
          assert.deepEqual(await service.state(), ended);
        },
        { signal: t.signal, interval: 100 },
      );

      // Act
      await launchd.install(job);

      // Assert
      assert.deepEqual(await service.state(), ended);
    } finally {
      await service.uninstall();
    }
  });

  test('install loads the job file that holds the same bytes, when the service is not loaded', async (t) => {
    // Arrange
    const label = `${PREFIX}reload`;
    const launchd = Launchd.agents({ clock: globalThis });
    const service = launchd.service(label);
    const job = {
      Label: label,
      ProgramArguments: ['/bin/sleep', '600'],
      RunAtLoad: true,
    } satisfies AgentJob;
    try {
      await launchd.install(job);
      await service.bootout();
      assert.deepEqual(await service.state(), { state: 'not loaded' });

      // Act
      await launchd.install(job);

      // Assert
      await waitFor(
        async () => {
          assert.equal((await service.state()).state, 'running');
        },
        { signal: t.signal, interval: 100 },
      );
    } finally {
      await service.uninstall();
    }
  });

  test('a changed job replaces the service that runs', async (t) => {
    // Arrange
    const label = `${PREFIX}changed`;
    const launchd = Launchd.agents({ clock: globalThis });
    const service = launchd.service(label);
    try {
      await launchd.install({
        Label: label,
        ProgramArguments: ['/bin/sleep', '600'],
        RunAtLoad: true,
      });
      const old = await waitFor(
        async () => {
          const state = await service.state();
          assert.ok(state.state === 'running', state.state);
          return state;
        },
        { signal: t.signal, interval: 100 },
      );

      // Act
      await launchd.install({
        Label: label,
        ProgramArguments: ['/bin/sh', '-c', 'exit 3'],
        RunAtLoad: true,
      });

      // Assert
      await waitFor(
        async () => {
          assert.deepEqual(await service.state(), {
            state: 'not running',
            lastExitStatus: 3,
          });
        },
        { signal: t.signal, interval: 100 },
      );
      assert.throws(() => process.kill(old.pid, 0), { code: 'ESRCH' });
    } finally {
      await service.uninstall();
    }
  });

  test('an install that a signal cancels in the wait for the old service keeps the old job file, and the next install replaces the service', async (t) => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('launchd-');
    const trapped = join(scratch.path, 'trapped');
    const terminated = join(scratch.path, 'terminated');
    const label = `${PREFIX}repair`;
    const launchd = Launchd.agents({ clock: globalThis });
    const service = launchd.service(label);
    const replacement = {
      Label: label,
      ProgramArguments: ['/bin/sleep', '600'],
      RunAtLoad: true,
    } satisfies AgentJob;
    try {
      // The process records launchd's SIGTERM and outlives it, so the bootout
      // of the old service has been accepted and the install waits when the
      // test aborts. The long ExitTimeOut keeps launchd from ending the
      // process first; the test ends it by its pid.
      await launchd.install({
        Label: label,
        ProgramArguments: [
          '/bin/sh',
          '-c',
          `trap ": > '${terminated}'" TERM; : > '${trapped}'; while :; do /bin/sleep 1; done`,
        ],
        RunAtLoad: true,
        ExitTimeOut: 600,
      });
      await waitFor(() => stat(trapped), { signal: t.signal, interval: 100 });
      const running = await service.state();
      assert.ok(running.state === 'running');
      const old = await readFile(service.file, 'utf8');
      const controller = new AbortController();

      // Act
      const cancelled = launchd.install(replacement, {
        signal: controller.signal,
      });
      await waitFor(() => stat(terminated), {
        signal: t.signal,
        interval: 100,
      });
      controller.abort(new Error('cancelled install'));

      // Assert
      await assert.rejects(
        cancelled,
        (error) => error === controller.signal.reason,
      );
      assert.notEqual((await service.state()).state, 'not loaded');
      process.kill(running.pid, 'SIGKILL');
      await waitFor(
        async () => {
          assert.deepEqual(await service.state(), { state: 'not loaded' });
        },
        { signal: t.signal, interval: 100 },
      );
      assert.equal(await readFile(service.file, 'utf8'), old);
      await launchd.install(replacement);
      await waitFor(
        async () => {
          assert.equal((await service.state()).state, 'running');
        },
        { signal: t.signal, interval: 100 },
      );
      assert.match(
        await readFile(service.file, 'utf8'),
        /<string>\/bin\/sleep<\/string>/,
      );
    } finally {
      await service.uninstall();
    }
  });

  test('install enables a service that was disabled, whether its job file is there or not', async (t) => {
    // Arrange
    const label = `${PREFIX}disabled`;
    const launchd = Launchd.agents({ clock: globalThis });
    const service = launchd.service(label);
    const job = {
      Label: label,
      ProgramArguments: ['/bin/sleep', '600'],
      RunAtLoad: true,
    } satisfies AgentJob;
    try {
      await launchd.install(job);
      await service.bootout();
      await service.disable();

      // Act: the same bytes are in the job file.
      await launchd.install(job);

      // Assert
      await waitFor(
        async () => {
          assert.equal((await service.state()).state, 'running');
        },
        { signal: t.signal, interval: 100 },
      );

      // Arrange
      await service.uninstall();
      await service.disable();

      // Act: there is no job file.
      await launchd.install(job);

      // Assert
      await waitFor(
        async () => {
          assert.equal((await service.state()).state, 'running');
        },
        { signal: t.signal, interval: 100 },
      );
    } finally {
      await service.uninstall();
    }
  });

  test('installed lists the job files of the folder by label, loaded or not, and not after uninstall', async () => {
    // Arrange
    const launchd = Launchd.agents({ clock: globalThis });
    const b = launchd.service(`${PREFIX}installed-b`);
    const a = launchd.service(`${PREFIX}installed-a`);
    const other = join(launchd.folder, `${PREFIX}installed-c.txt`);
    try {
      await writeFile(other, '');
      await launchd.install({
        Label: b.label,
        ProgramArguments: ['/bin/sleep', '600'],
      });
      await launchd.install({
        Label: a.label,
        ProgramArguments: ['/bin/sleep', '600'],
      });
      await a.bootout();

      // Act
      const listed = await launchd.installed();

      // Assert
      const labels = listed.map((service) => service.label);
      // a is not loaded; the .txt file is not a job file.
      assert.deepEqual(
        labels.filter((label) => label.startsWith(`${PREFIX}installed`)),
        [a.label, b.label],
      );
      const listedB = listed.find((service) => service.label === b.label);
      assert.equal(listedB?.file, b.file);
      assert.equal(listedB?.target, b.target);
      await a.uninstall();
      await b.uninstall();
      const after = (await launchd.installed()).map((service) => service.label);
      assert.ok(!after.includes(a.label) && !after.includes(b.label));
    } finally {
      await rm(other, { force: true });
      await a.uninstall();
      await b.uninstall();
    }
  });

  test('a handle of a label that was never installed names its file and target, makes no file, and its state is not loaded', async () => {
    const launchd = Launchd.agents({ clock: globalThis });

    const service = launchd.service(`${PREFIX}handle`);

    assert.equal(service.label, `${PREFIX}handle`);
    assert.equal(service.target, `${launchd.domain}/${PREFIX}handle`);
    assert.equal(service.file, join(launchd.folder, `${PREFIX}handle.plist`));
    assert.deepEqual(await service.state(), { state: 'not loaded' });
    await assert.rejects(stat(service.file), { code: 'ENOENT' });
  });

  test('a call given a signal that already aborted rejects with its reason', async () => {
    const launchd = Launchd.agents({ clock: globalThis });
    const signal = AbortSignal.abort(new Error('cancelled'));

    const state = launchd.service(`${PREFIX}aborted`).state({ signal });

    await assert.rejects(state, (error) => error === signal.reason);
    await assert.rejects(
      launchd.installed({ signal }),
      (error) => error === signal.reason,
    );
  });

  test('a daemon of a process that is not root gets PermissionDeniedError from launchctl, and nothing is left', async () => {
    // Arrange
    const label = `${PREFIX}daemon`;
    const daemons = Launchd.daemons({ clock: globalThis });
    const service = daemons.service(label);

    // Act
    const install = daemons.install({
      Label: label,
      ProgramArguments: ['/bin/sleep', '600'],
      UserName: 'nobody',
    });

    // Assert
    assert.equal(daemons.domain, 'system');
    assert.equal(daemons.folder, '/Library/LaunchDaemons');
    await assert.rejects(install, (error) => {
      assert.ok(error instanceof PermissionDeniedError);
      assert.ok(error.cause instanceof LaunchctlError);
      assert.deepEqual(error.cause.args, ['bootout', `system/${label}`]);
      assert.equal(error.cause.exitCode, 1);
      return true;
    });
    await assert.rejects(stat(service.file), { code: 'ENOENT' });
    assert.deepEqual(await service.state(), { state: 'not loaded' });
    await assert.rejects(service.uninstall(), PermissionDeniedError);
  });

  test('the agents folder is Library/LaunchAgents under HOME, so a program run with another HOME keeps its job files there', async () => {
    // Arrange
    await using home = await new TemporaryFiles().directory('launchd-home-');

    // Act
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const { Launchd } = await import(${JSON.stringify(import.meta.resolve('../index.ts'))});
        process.stdout.write(Launchd.agents({ clock: globalThis }).folder);`,
      ],
      { env: { ...process.env, HOME: home.path } },
    );

    // Assert
    assert.equal(stdout, join(home.path, 'Library/LaunchAgents'));
  });

  test('install under another HOME writes the job file under that HOME and loads the service', async () => {
    // Arrange
    await using home = await new TemporaryFiles().directory('launchd-home-');
    const label = `${PREFIX}home`;

    // Act
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const { Launchd } = await import(${JSON.stringify(import.meta.resolve('../index.ts'))});
        const launchd = Launchd.agents({ clock: globalThis });
        const service = launchd.service(${JSON.stringify(label)});
        try {
          const installed = await launchd.install({
            Label: service.label,
            ProgramArguments: ['/bin/sleep', '600'],
            RunAtLoad: true,
          });
          const { state } = await installed.state();
          process.stdout.write(JSON.stringify({ file: installed.file, state }));
        } finally {
          await service.uninstall();
        }`,
      ],
      { env: { ...process.env, HOME: home.path } },
    );

    // Assert
    const { file, state } = JSON.parse(stdout);
    assert.equal(file, join(home.path, `Library/LaunchAgents/${label}.plist`));
    assert.notEqual(state, 'not loaded');
  });
});

// Outside the describe, so no other test writes a file under this umask.
test('install writes the job file with mode 0644 under a umask that takes the read bits of the group and others', async () => {
  // Arrange
  const launchd = Launchd.agents({ clock: globalThis });
  const service = launchd.service(`${PREFIX}umask`);
  const umask = process.umask(0o077);
  try {
    // Act
    await launchd.install({
      Label: service.label,
      ProgramArguments: ['/bin/sleep', '600'],
    });

    // Assert
    assert.equal((await stat(service.file)).mode & 0o777, 0o644);
  } finally {
    process.umask(umask);
    await service.uninstall();
  }
});

test('the tests of Launchd leave no job file and no service of theirs', async () => {
  const launchd = Launchd.agents({ clock: globalThis });

  const files = await readdir(launchd.folder);
  const { stdout } = await promisify(execFile)('/bin/launchctl', [
    'print',
    launchd.domain,
  ]);

  assert.deepEqual(
    files.filter((name) => name.startsWith(PREFIX)),
    [],
  );
  // Only the services section: the section of overrides keeps each label
  // that was ever enabled, and no subcommand removes one.
  const services = /^\tservices = \{$(.*?)^\t\}$/ms.exec(stdout)?.[1] ?? '';
  assert.ok(services.includes('com.apple.'), 'reads the services section');
  assert.ok(!services.includes(PREFIX));
});
