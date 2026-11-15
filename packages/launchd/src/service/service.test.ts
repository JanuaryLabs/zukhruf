import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { constants } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  type AgentJob,
  LaunchctlError,
  Launchd,
  LaunchdError,
  PermissionDeniedError,
  ServiceNotFoundError,
} from '../index.ts';

// The labels of this file. They are fixed, because launchd keeps the enable
// override of each label it saw, and the other test file has its own.
const PREFIX = 'dev.zukhruf.launchd.test.service.';
const WAIT = { interval: 100, timeout: 20_000 };

describe('Service', { concurrency: true }, () => {
  test('kickstart and kill of a label that the domain does not have reject with ServiceNotFoundError', async () => {
    // Arrange
    const service = Launchd.agents({ clock: globalThis }).service(
      `${PREFIX}never-loaded`,
    );

    // Act and Assert
    await assert.rejects(service.kickstart(), (error) => {
      assert.ok(error instanceof ServiceNotFoundError);
      assert.ok(error instanceof LaunchctlError);
      assert.ok(error instanceof LaunchdError);
      assert.equal(error.target, service.target);
      assert.deepEqual(error.args, ['kickstart', '-p', service.target]);
      assert.equal(error.exitCode, 113);
      assert.match(error.stderr, /Could not find service/);
      assert.ok(
        error.message.includes(`launchctl kickstart -p ${service.target}`),
      );
      assert.ok(error.message.includes(error.stderr.trim()));
      return true;
    });
    await assert.rejects(service.kill('SIGTERM'), (error) => {
      assert.ok(error instanceof ServiceNotFoundError);
      assert.deepEqual(error.args, ['kill', 'SIGTERM', service.target]);
      return true;
    });
  });

  test('a label that is not loaded and has no job file takes a bootout, an uninstall, a disable and an enable', async () => {
    // Arrange
    const service = Launchd.agents({ clock: globalThis }).service(
      `${PREFIX}absent`,
    );

    // Act
    await service.bootout();
    await service.uninstall();
    await service.disable();
    await service.enable();

    // Assert
    assert.deepEqual(await service.state(), { state: 'not loaded' });
    await assert.rejects(stat(service.file), { code: 'ENOENT' });
  });

  for (const { name, program, status } of [
    { name: 'true', program: ['/usr/bin/true'], status: 0 },
    { name: 'false', program: ['/usr/bin/false'], status: 1 },
    { name: 'exit-3', program: ['/bin/sh', '-c', 'exit 3'], status: 3 },
  ] satisfies {
    name: string;
    program: readonly [string, ...string[]];
    status: number;
  }[]) {
    test(`state gives the exit status ${status} of a process that ended`, async (t) => {
      // Arrange
      const launchd = Launchd.agents({ clock: globalThis });
      const service = launchd.service(`${PREFIX}${name}`);
      try {
        // Act
        await launchd.install({
          Label: service.label,
          ProgramArguments: program,
          RunAtLoad: true,
        });

        // Assert
        await t.waitFor(async () => {
          assert.deepEqual(await service.state(), {
            state: 'not running',
            lastExitStatus: status,
          });
        }, WAIT);
      } finally {
        await service.uninstall();
      }
    });
  }

  test('kickstart runs a service that does not run, gives the PID of a service that runs, and with kill gives a new one; a signal ends the process with no exit status', async (t) => {
    // Arrange
    const launchd = Launchd.agents({ clock: globalThis });
    const service = launchd.service(`${PREFIX}kickstart`);
    try {
      await launchd.install({
        Label: service.label,
        ProgramArguments: ['/bin/sleep', '600'],
        // launchd waits 10 s by default before it starts a job again.
        ThrottleInterval: 1,
      });
      assert.deepEqual(await service.state(), {
        state: 'not running',
        lastExitStatus: undefined,
      });

      // Act
      const pid = await service.kickstart();

      // Assert
      assert.deepEqual(await service.state(), {
        state: 'running',
        pid,
        lastExitStatus: undefined,
      });
      assert.equal(await service.kickstart(), pid);
      const restarted = await service.kickstart({ kill: true });
      assert.notEqual(restarted, pid);
      const running = await service.state();
      assert.ok(running.state === 'running');
      assert.equal(running.pid, restarted);
      await service.kill('SIGTERM');
      await t.waitFor(async () => {
        assert.deepEqual(await service.state(), {
          state: 'not running',
          lastExitStatus: undefined,
        });
      }, WAIT);
      await assert.rejects(service.kill('SIGTERM'), (error) => {
        assert.ok(error instanceof LaunchctlError);
        assert.ok(!(error instanceof ServiceNotFoundError));
        assert.equal(error.exitCode, 3);
        return true;
      });
    } finally {
      await service.uninstall();
    }
  });

  test('state of a service that runs again gives the exit status of its run before', async (t) => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('launchd-');
    const ran = join(scratch.path, 'ran');
    const launchd = Launchd.agents({ clock: globalThis });
    const service = launchd.service(`${PREFIX}second-run`);
    try {
      await launchd.install({
        Label: service.label,
        ProgramArguments: [
          '/bin/sh',
          '-c',
          `[ -e '${ran}' ] && exec /bin/sleep 600; : > '${ran}'; exit 3`,
        ],
        RunAtLoad: true,
        // launchd waits 10 s by default before it starts a job again.
        ThrottleInterval: 1,
      });
      await t.waitFor(async () => {
        assert.deepEqual(await service.state(), {
          state: 'not running',
          lastExitStatus: 3,
        });
      }, WAIT);

      // Act
      const pid = await service.kickstart();

      // Assert
      assert.deepEqual(await service.state(), {
        state: 'running',
        pid,
        lastExitStatus: 3,
      });
    } finally {
      await service.uninstall();
    }
  });

  test('kill sends the process signal that it names, by name or by number', async (t) => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('launchd-');
    const trapped = join(scratch.path, 'trapped');
    const launchd = Launchd.agents({ clock: globalThis });
    const service = launchd.service(`${PREFIX}kill`);
    const job = {
      Label: service.label,
      ProgramArguments: [
        '/bin/sh',
        '-c',
        `trap 'exit 7' HUP; trap 'exit 9' USR1; : > '${trapped}'; while :; do /bin/sleep 1; done`,
      ],
      // launchd waits 10 s by default before it starts a job again.
      ThrottleInterval: 1,
    } satisfies AgentJob;
    try {
      await launchd.install(job);
      await service.kickstart();
      await t.waitFor(() => stat(trapped), WAIT);

      // Act
      await service.kill('SIGHUP');

      // Assert
      await t.waitFor(async () => {
        assert.deepEqual(await service.state(), {
          state: 'not running',
          lastExitStatus: 7,
        });
      }, WAIT);

      // Arrange
      await rm(trapped);
      await service.kickstart();
      await t.waitFor(() => stat(trapped), WAIT);

      // Act
      await service.kill(constants.signals.SIGUSR1);

      // Assert
      await t.waitFor(async () => {
        assert.deepEqual(await service.state(), {
          state: 'not running',
          lastExitStatus: 9,
        });
      }, WAIT);
    } finally {
      await service.uninstall();
    }
  });

  test('disable keeps a loaded service, and a disabled service does not bootstrap until enable', async (t) => {
    // Arrange
    const launchd = Launchd.agents({ clock: globalThis });
    const service = launchd.service(`${PREFIX}disable`);
    try {
      await launchd.install({
        Label: service.label,
        ProgramArguments: ['/bin/sleep', '600'],
        RunAtLoad: true,
      });
      const before = await t.waitFor(async () => {
        const state = await service.state();
        assert.ok(state.state === 'running', state.state);
        return state;
      }, WAIT);

      // Act
      await service.disable();

      // Assert
      assert.deepEqual(await service.state(), before);
      await service.bootout();
      await assert.rejects(service.bootstrap(), (error) => {
        assert.ok(error instanceof LaunchctlError);
        assert.ok(!(error instanceof ServiceNotFoundError));
        assert.ok(!(error instanceof PermissionDeniedError));
        assert.deepEqual(error.args, [
          'bootstrap',
          launchd.domain,
          service.file,
        ]);
        assert.equal(error.exitCode, 5);
        return true;
      });
      assert.deepEqual(await service.state(), { state: 'not loaded' });
      await service.enable();
      await service.bootstrap();
      await t.waitFor(async () => {
        assert.equal((await service.state()).state, 'running');
      }, WAIT);
    } finally {
      await service.uninstall();
    }
  });

  test('bootout removes the service and keeps the job file, and bootstrap loads it again', async (t) => {
    // Arrange
    const launchd = Launchd.agents({ clock: globalThis });
    const service = launchd.service(`${PREFIX}bootout`);
    try {
      await launchd.install({
        Label: service.label,
        ProgramArguments: ['/bin/sleep', '600'],
        RunAtLoad: true,
      });
      const content = await readFile(service.file, 'utf8');

      // Act
      await service.bootout();

      // Assert
      assert.deepEqual(await service.state(), { state: 'not loaded' });
      assert.equal(await readFile(service.file, 'utf8'), content);
      await service.bootstrap();
      await t.waitFor(async () => {
        assert.equal((await service.state()).state, 'running');
      }, WAIT);
    } finally {
      await service.uninstall();
    }
  });

  test('bootout waits until launchd forgets a process that outlives SIGTERM, so a bootstrap right after it loads the job', async (t) => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('launchd-');
    const trapped = join(scratch.path, 'trapped');
    const launchd = Launchd.agents({ clock: globalThis });
    const service = launchd.service(`${PREFIX}slow-exit`);
    try {
      await launchd.install({
        Label: service.label,
        ProgramArguments: [
          '/bin/sh',
          '-c',
          `trap '' TERM; : > '${trapped}'; while :; do /bin/sleep 1; done`,
        ],
        RunAtLoad: true,
        ExitTimeOut: 2,
      });
      await t.waitFor(() => stat(trapped), WAIT);
      const old = await service.state();
      assert.ok(old.state === 'running');

      // Act
      await service.bootout();

      // Assert
      assert.deepEqual(await service.state(), { state: 'not loaded' });
      assert.throws(() => process.kill(old.pid, 0), { code: 'ESRCH' });
      await service.bootstrap();
      await t.waitFor(async () => {
        const state = await service.state();
        assert.ok(state.state === 'running');
        assert.notEqual(state.pid, old.pid);
      }, WAIT);
    } finally {
      await service.uninstall();
    }
  });

  test('a signal cancels the wait of bootout and of uninstall, and launchd still forgets the service', async (t) => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('launchd-');
    const started = join(scratch.path, 'started');
    const terminated = join(scratch.path, 'terminated');
    const launchd = Launchd.agents({ clock: globalThis });
    const service = launchd.service(`${PREFIX}cancel`);
    // The process records launchd's SIGTERM and outlives it, so the bootout
    // has been accepted and its wait is running when the test aborts. The
    // long ExitTimeOut keeps launchd from ending the process first; the test
    // ends it by its pid.
    const job = {
      Label: service.label,
      ProgramArguments: [
        '/bin/sh',
        '-c',
        `trap ": > '${terminated}'" TERM; : > '${started}'; while :; do /bin/sleep 1; done`,
      ],
      RunAtLoad: true,
      ExitTimeOut: 600,
    } satisfies AgentJob;
    try {
      await launchd.install(job);
      await t.waitFor(() => stat(started), WAIT);
      const running = await service.state();
      assert.ok(running.state === 'running');
      const bootoutController = new AbortController();

      // Act
      const bootout = service.bootout({ signal: bootoutController.signal });
      await t.waitFor(() => stat(terminated), WAIT);
      bootoutController.abort(new Error('cancelled bootout'));

      // Assert
      await assert.rejects(
        bootout,
        (error) => error === bootoutController.signal.reason,
      );
      assert.notEqual((await service.state()).state, 'not loaded');
      process.kill(running.pid, 'SIGKILL');
      await t.waitFor(async () => {
        assert.deepEqual(await service.state(), { state: 'not loaded' });
      }, WAIT);

      // Arrange
      await rm(started);
      await rm(terminated);
      await service.bootstrap();
      await t.waitFor(() => stat(started), WAIT);
      const rerun = await service.state();
      assert.ok(rerun.state === 'running');
      const uninstallController = new AbortController();

      // Act
      const uninstall = service.uninstall({
        signal: uninstallController.signal,
      });
      await t.waitFor(() => stat(terminated), WAIT);
      uninstallController.abort(new Error('cancelled uninstall'));

      // Assert
      await assert.rejects(
        uninstall,
        (error) => error === uninstallController.signal.reason,
      );
      process.kill(rerun.pid, 'SIGKILL');
      await t.waitFor(async () => {
        assert.deepEqual(await service.state(), { state: 'not loaded' });
      }, WAIT);
      await stat(service.file);
    } finally {
      await service.uninstall();
    }
  });

  test('uninstall removes the service and the job file', async (t) => {
    // Arrange
    const launchd = Launchd.agents({ clock: globalThis });
    const service = launchd.service(`${PREFIX}uninstall`);
    try {
      await launchd.install({
        Label: service.label,
        ProgramArguments: ['/bin/sleep', '600'],
        RunAtLoad: true,
      });
      await t.waitFor(async () => {
        assert.equal((await service.state()).state, 'running');
      }, WAIT);

      // Act
      await service.uninstall();

      // Assert
      assert.deepEqual(await service.state(), { state: 'not loaded' });
      await assert.rejects(stat(service.file), { code: 'ENOENT' });
    } finally {
      await service.uninstall();
    }
  });
});

test('the tests of Service leave no job file and no service of theirs', async () => {
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
