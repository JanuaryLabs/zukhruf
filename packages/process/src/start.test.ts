import assert from 'node:assert/strict';
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createClock } from '@sinonjs/fake-timers';

import { poll } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';

import {
  Command,
  type CommandOptions,
  ProcessEndedError,
  StartError,
} from './index.ts';

const index = import.meta.resolve('./index.ts');

/** Whether `pid` runs: it exists and is not a zombie that waits for its parent. */
function running(pid: number): boolean {
  try {
    const stat = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    return stat !== '' && !stat.startsWith('Z');
  } catch (error) {
    // ps exits with 1 when no process has the pid.
    if (Reflect.get(Object(error), 'status') === 1) return false;
    throw error;
  }
}

/**
 * Whether the process group `pgid` has a member, a zombie too: macOS answers
 * EPERM for a group of zombies that are not reaped yet.
 */
function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = Reflect.get(Object(error), 'code');
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw error;
  }
}

/** SIGKILL to the group; ESRCH and EPERM say that no member of it runs. */
function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch (error) {
    const code = Reflect.get(Object(error), 'code');
    if (code !== 'ESRCH' && code !== 'EPERM') throw error;
  }
}

function groupOf(pid: number): number {
  return Number(
    execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim(),
  );
}

/** The pids that a process wrote so far, one on each line. */
async function pidsOf(file: string): Promise<number[]> {
  const text = await readFile(file, 'utf8').catch((error: unknown) => {
    // The process has not written the file yet.
    if (Reflect.get(Object(error), 'code') === 'ENOENT') return '';
    throw error;
  });
  return text.split('\n').filter(Boolean).map(Number);
}

/** The pid that a process wrote, once it is there. */
function pidIn(file: string, signal: AbortSignal): Promise<number> {
  return poll(async () => (await pidsOf(file))[0], {
    interval: 20,
    clock: globalThis,
    signal,
  });
}

/** The pid of a process and of its child, once both are there. */
function pidsIn(
  file: string,
  signal: AbortSignal,
): Promise<readonly [number, number]> {
  return poll(
    async () => {
      const [process, child] = await pidsOf(file);
      return process === undefined || child === undefined
        ? undefined
        : ([process, child] as const);
    },
    { interval: 20, clock: globalThis, signal },
  );
}

const node = (
  source: string,
  options: Partial<Pick<CommandOptions, 'grace' | 'clock'>> = {},
) =>
  new Command(process.execPath, ['-e', source], {
    clock: globalThis,
    env: {},
    name: 'the helper',
    ...options,
  });

/** A Node.js process with a child; both ignore SIGTERM, and it writes both pids. */
const ignoresTermWithChild = (pids: string) =>
  `process.on('SIGTERM', () => {});
   const child = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
   require('node:fs').writeFileSync(${JSON.stringify(pids)}, process.pid + '\\n' + child.pid + '\\n');
   setInterval(() => {}, 1000);`;

/**
 * A Perl process that forks X. X forks Y, leaves the group and never reaps Y,
 * so a SIGTERM to the group leaves only the zombie Y in it. X writes its pid
 * and the pid of Y.
 */
const LEAVES_A_ZOMBIE = String.raw`
if (fork // die) { sleep 1000; exit 0 }
open STDIN, '<', '/dev/null'; open STDOUT, '>', '/dev/null'; open STDERR, '>', '/dev/null';
my $y = fork // die;
if ($y == 0) { sleep 1000; exit 0 }
setpgrp(0, 0) or die;
open my $f, '>', $ARGV[0] or die; print $f "$$\n$y\n"; close $f;
sleep 1000;`;

test('a start of a file that does not exist rejects with StartError, whose cause is ENOENT, naming the command', async () => {
  // Act
  const started = new Command('/nonexistent/zukhruf-tool', ['--token=secret'], {
    clock: globalThis,
    env: {},
    name: 'the uploader',
  }).start();

  // Assert
  await assert.rejects(started, (error) => {
    assert.ok(error instanceof StartError);
    assert.equal(Reflect.get(Object(error.cause), 'code'), 'ENOENT');
    assert.ok(error.message.includes('the uploader'));
    return true;
  });
});

test('a process that ends before its ready line rejects the start with ProcessEndedError, with the end and the stderr tail, naming the process but not its arguments', async () => {
  // Act
  const started = new Command(
    process.execPath,
    [
      '-e',
      "process.stderr.write('config missing'); process.exit(4)",
      '--',
      '--token=secret',
    ],
    { clock: globalThis, env: {}, name: 'the helper' },
  ).start({ ready: { line: 'ready' } });

  // Assert
  await assert.rejects(started, (error) => {
    assert.ok(error instanceof ProcessEndedError);
    assert.deepEqual(error.end, { exitCode: 4 });
    assert.equal(error.stderr, 'config missing');
    assert.match(error.message, /ended \(exit code 4\) before it was ready/);
    assert.ok(error.message.includes('the helper'));
    assert.ok(!error.message.includes('secret'));
    return true;
  });
});

test('an abort before the ready line rejects the start with its reason, and the group is empty when it settles', async (t) => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  const pids = join(folder.path, 'pids');
  const controller = new AbortController();
  const reason = new Error('gave up');
  const started = node(
    `require('node:fs').writeFileSync(${JSON.stringify(pids)}, process.pid + '\\n'); setInterval(() => {}, 1000);`,
  ).start({ ready: { line: 'ready' }, signal: controller.signal });
  const pid = await pidIn(pids, t.signal);
  const pgid = groupOf(pid);
  try {
    // Act
    controller.abort(reason);

    // Assert
    await assert.rejects(started, (error) => error === reason);
    assert.equal(groupExists(pgid), false);
  } finally {
    killGroup(pgid);
  }
});

test('an abort after the ready line stops the process, and its end is SIGTERM', async () => {
  // Arrange
  const controller = new AbortController();
  const started = await node(
    "console.log('ready'); setInterval(() => {}, 1000);",
  ).start({
    ready: { line: 'ready' },
    signal: controller.signal,
  });

  // Act
  controller.abort(new Error('stop now'));

  // Assert
  assert.deepEqual(await started.ended, { signal: 'SIGTERM' });
});

test('a start given an aborted signal rejects with its reason, and spawns no process', async () => {
  // Arrange
  const reason = new Error('the caller gave up');
  const spawned: unknown[] = [];
  const onSpawn = (message: unknown) => spawned.push(message);
  subscribe('child_process', onSpawn);
  try {
    // Act
    const started = new Command('/usr/bin/true', [], {
      clock: globalThis,
      env: {},
    }).start({ signal: AbortSignal.abort(reason) });

    // Assert
    await assert.rejects(started, (error) => error === reason);
    assert.deepEqual(spawned, []);
  } finally {
    unsubscribe('child_process', onSpawn);
  }
});

test('an abort that comes while the start is under way rejects it with its reason, and the process that it spawned is gone', async () => {
  // Arrange
  const reason = new Error('the caller gave up');
  const controller = new AbortController();
  const spawned: ChildProcess[] = [];
  const onSpawn = (message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'process' in message &&
      message.process instanceof ChildProcess
    )
      spawned.push(message.process);
  };
  subscribe('child_process', onSpawn);
  // The channel speaks before the pid exists, so the pids are read at the end.
  const groups = () =>
    spawned
      .map((child) => child.pid)
      .filter((pid): pid is number => pid !== undefined);
  try {
    // Act
    const started = node('setInterval(() => {}, 1000);').start({
      signal: controller.signal,
    });
    controller.abort(reason);

    // Assert
    await assert.rejects(started, (error) => error === reason);
    assert.deepEqual(groups().map(groupExists), [false]);
  } finally {
    unsubscribe('child_process', onSpawn);
    for (const pgid of groups()) killGroup(pgid);
  }
});

test('the pid of a started process is the pid of the program that it started, so a signal to it reaches the program', async () => {
  // Arrange
  await using started = await node(
    "console.log(process.pid); process.stdin.once('data', () => {});",
  ).start();
  const own = Number(
    (await started.lines()[Symbol.asyncIterator]().next()).value,
  );

  assert.equal(started.pid, own);

  // Act
  process.kill(started.pid, 'SIGSTOP');
  process.kill(started.pid, 'SIGKILL');

  // Assert
  assert.deepEqual(await started.ended, { signal: 'SIGKILL' });
});

test('a started process whose parent is killed with SIGKILL ends, and so does its child', async (t) => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  const pids = join(folder.path, 'pids');
  const parent = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { Command } from ${JSON.stringify(index)};
       await new Command('/bin/sh', ['-c', "echo $$ > '${pids}'; sleep 1000 & echo $! >> '${pids}'; wait"], { clock: globalThis, env: {} }).start();
       setInterval(() => {}, 1000);`,
    ],
    { stdio: 'ignore' },
  );
  const exited = once(parent, 'exit');
  const [target, child] = await pidsIn(pids, t.signal);
  try {
    // Act
    parent.kill('SIGKILL');
    await exited;

    // Assert
    const gone = await poll(
      async () => (!running(target) && !running(child) ? true : undefined),
      { interval: 20, clock: globalThis, signal: t.signal },
    );
    assert.equal(gone, true);
  } finally {
    for (const pid of [target, child])
      if (running(pid)) process.kill(pid, 'SIGKILL');
  }
});

void test.each(
  [
    [
      '"ready", a whole line equal to it',
      'ready',
      ['starting', 'not ready yet', 'ready now', 'is ready', 'READY'],
    ],
    [
      '/^listening on \\d+$/',
      /^listening on \d+$/,
      ['starting', 'listening on port', 'listening on 4321 now'],
    ],
  ] as const,
  ([name, line, printed]) =>
    test(`with the ready line ${name}, a process that prints ${JSON.stringify(printed)} and ends rejects the start with ProcessEndedError`, async () => {
      // Act
      const started = node(
        printed.map((one) => `console.log(${JSON.stringify(one)});`).join(' '),
      ).start({ ready: { line } });

      // Assert
      await assert.rejects(started, (error) => {
        assert.ok(error instanceof ProcessEndedError);
        assert.deepEqual(error.end, { exitCode: 0 });
        return true;
      });
    }),
);

test('a ready line as a regular expression resolves the start at the first line that matches', async () => {
  // Act
  await using started = await node(
    "console.log('starting'); console.log('listening on 4321'); setInterval(() => {}, 1000);",
  ).start({ ready: { line: /^listening on \d+$/ } });

  // Assert
  assert.equal(typeof started.pid, 'number');
});

test('a start with no ready line resolves while the process runs', async () => {
  // Act
  await using started = await node('setInterval(() => {}, 1000);').start();

  // Assert
  assert.equal(running(started.pid), true);
});

test('stop() sends SIGTERM to the group and resolves with the end, which ended gives too', async () => {
  // Arrange
  const started = await node('setInterval(() => {}, 1000);').start();

  // Act
  const end = await started.stop();

  // Assert
  assert.deepEqual(
    [end, await started.ended],
    [{ signal: 'SIGTERM' }, { signal: 'SIGTERM' }],
  );
});

void test.each(
  [
    ['the given grace of 3 seconds', { grace: 3000 }, 3000],
    ['5 seconds when the command gives no grace', {}, 5000],
  ] as const,
  ([name, options, killedAtGrace]) =>
    test(`stop() of a process that ignores SIGTERM sends SIGKILL to its group at ${name} on the clock, and its child ends too`, async (t) => {
      // Arrange
      await using folder = await new TemporaryFiles().directory('process-');
      const pids = join(folder.path, 'pids');
      const clock = createClock();
      const started = await node(ignoresTermWithChild(pids), {
        ...options,
        clock,
      }).start();
      const [pid, child] = await pidsIn(pids, t.signal);
      try {
        // Act
        const stopped = started.stop();
        const killedAt = await clock.nextAsync();

        // Assert
        assert.equal(killedAt, killedAtGrace);
        assert.deepEqual(await stopped, { signal: 'SIGKILL' });
        const gone = await poll(
          async () => (!running(pid) && !running(child) ? true : undefined),
          { interval: 20, clock: globalThis, signal: t.signal },
        );
        assert.equal(gone, true);
      } finally {
        for (const one of [pid, child])
          if (running(one)) process.kill(one, 'SIGKILL');
      }
    }),
);

test('the disposal stops the process and resolves when the group is empty, also with a member that ends after the keeper, and stdout has ended', async (t) => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  const pids = join(folder.path, 'pids');
  const lingering = `trap 'sleep 0.3; exit 0' TERM; while :; do sleep 1; done`;
  const started = await new Command(
    '/bin/sh',
    ['-c', `echo $$ > '${pids}'; sh -c "${lingering}" >/dev/null 2>&1 & wait`],
    { clock: globalThis, env: {} },
  ).start();
  const pgid = groupOf(await pidIn(pids, t.signal));
  try {
    // Act
    await started[Symbol.asyncDispose]();

    // Assert
    const lines = await Array.fromAsync(started.lines());
    assert.deepEqual([groupExists(pgid), lines], [false, []]);
  } finally {
    killGroup(pgid);
  }
});

test('stop() resolves with the end at the grace when only a zombie is left in the group, whose parent left the group and never reaps it', async (t) => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  const pids = join(folder.path, 'pids');
  const clock = createClock();
  const started = await new Command(
    '/usr/bin/perl',
    ['-e', LEAVES_A_ZOMBIE, pids],
    {
      clock,
      env: {},
      grace: 2000,
    },
  ).start();
  const [parent] = await pidsIn(pids, t.signal);
  try {
    // Act
    const stopped = started.stop().then((end) => ({ end, at: clock.now }));
    await started.ended;
    await clock.tickAsync(2000);

    // Assert
    assert.deepEqual(await stopped, { end: { signal: 'SIGTERM' }, at: 2000 });
  } finally {
    killGroup(started.pid);
    process.kill(parent, 'SIGKILL');
  }
});

test('ended settles once with the end when the process ends by itself, and a second read gives the same end', async () => {
  // Arrange
  const started = await node('process.exit(3);').start();

  // Act
  const first = await started.ended;
  const second = await started.ended;

  // Assert
  assert.deepEqual([first, second], [{ exitCode: 3 }, { exitCode: 3 }]);
});

test('a started process gets the given environment and nothing else', async () => {
  // Arrange
  await using started = await new Command('/usr/bin/env', [], {
    clock: globalThis,
    env: { ZUKHRUF_GIVEN: 'yes', ZUKHRUF_LEFT_OUT: undefined },
  }).start();

  // Act
  const lines = await Array.fromAsync(started.lines());

  // Assert
  assert.deepEqual(lines, ['ZUKHRUF_GIVEN=yes']);
});
