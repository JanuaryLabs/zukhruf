import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';

import { poll } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';

import { Command } from './index.ts';

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

/** A Node.js process that ignores SIGTERM, writes its pid and waits forever. */
const ignoresTerm = (pids: string) =>
  `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pids)}, process.pid + '\\n'); setInterval(() => {}, 1000);`;

test('a run given an aborted signal rejects with its reason, and spawns no process', async () => {
  // Arrange
  const reason = new Error('the caller gave up');
  const command = new Command('/usr/bin/true', [], {
    clock: globalThis,
    env: {},
  });
  const spawned: unknown[] = [];
  const onSpawn = (message: unknown) => spawned.push(message);
  subscribe('child_process', onSpawn);
  try {
    // Act
    const run = command.run({ signal: AbortSignal.abort(reason) });

    // Assert
    await assert.rejects(run, (error) => error === reason);
    assert.deepEqual(spawned, []);
  } finally {
    unsubscribe('child_process', onSpawn);
  }
});

test('an abort during a run rejects with its reason only when no member of the process group is left, also a child that takes its time to end after SIGTERM', async (t) => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  const pids = join(folder.path, 'pids');
  const lingering = `trap 'sleep 0.3; exit 0' TERM; while :; do sleep 1; done`;
  const command = new Command(
    '/bin/sh',
    ['-c', `echo $$ > '${pids}'; sh -c "${lingering}" >/dev/null 2>&1 & wait`],
    { clock: globalThis, env: {} },
  );
  const controller = new AbortController();
  const reason = new Error('stop');
  const run = command.run({ signal: controller.signal });
  const target = await pidIn(pids, t.signal);
  const pgid = groupOf(target);
  try {
    // Act
    controller.abort(reason);
    await assert.rejects(run, (error) => error === reason);

    // Assert
    assert.equal(groupExists(pgid), false);
  } finally {
    killGroup(pgid);
  }
});

test('an abort of a process that ignores SIGTERM sends SIGKILL to its group when the given grace has passed on the clock', async (t) => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  const pids = join(folder.path, 'pids');
  const clock = createClock();
  const command = new Command(process.execPath, ['-e', ignoresTerm(pids)], {
    clock,
    env: {},
    grace: 7000,
  });
  const controller = new AbortController();
  const reason = new Error('stop');
  const run = command.run({ signal: controller.signal });
  const pid = await pidIn(pids, t.signal);
  try {
    // Act
    controller.abort(reason);
    const rejected = assert.rejects(run, (error) => error === reason);
    const killedAt = await clock.nextAsync();

    // Assert
    assert.equal(killedAt, 7000);
    await rejected;
    assert.equal(running(pid), false);
  } finally {
    if (running(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('the grace is 5 seconds when the command gives none', async (t) => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  const pids = join(folder.path, 'pids');
  const clock = createClock();
  const command = new Command(process.execPath, ['-e', ignoresTerm(pids)], {
    clock,
    env: {},
  });
  const controller = new AbortController();
  const run = command.run({ signal: controller.signal });
  const pid = await pidIn(pids, t.signal);
  try {
    // Act
    controller.abort(new Error('stop'));
    const rejected = assert.rejects(run);
    const killedAt = await clock.nextAsync();

    // Assert
    assert.equal(killedAt, 5000);
    await rejected;
  } finally {
    if (running(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('a run whose parent is killed with SIGKILL ends, and so does its child', async (t) => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  const pids = join(folder.path, 'pids');
  const parent = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { Command } from ${JSON.stringify(index)};
       await new Command('/bin/sh', ['-c', "echo $$ > '${pids}'; sleep 30 & echo $! >> '${pids}'; wait"], { clock: globalThis, env: {} }).run();`,
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
      async () =>
        !running(target) && !running(child)
          ? ([false, false] as const)
          : undefined,
      { interval: 20, clock: globalThis, signal: t.signal },
    );
    assert.deepEqual(gone, [false, false]);
  } finally {
    for (const pid of [target, child])
      if (running(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('when the parent is killed with SIGKILL, a process that ignores SIGTERM gets SIGKILL from the keeper once the grace has passed', async (t) => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('process-');
  const pids = join(folder.path, 'pids');
  const parent = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { Command } from ${JSON.stringify(index)};
       await new Command(process.execPath, ['-e', ${JSON.stringify(ignoresTerm(pids))}], { clock: globalThis, env: {}, grace: 1000 }).run();`,
    ],
    { stdio: 'ignore' },
  );
  const exited = once(parent, 'exit');
  const pid = await pidIn(pids, t.signal);
  try {
    // Act
    const killedAt = performance.now();
    parent.kill('SIGKILL');
    await exited;
    const afterTheKill = running(pid);
    await poll(async () => (running(pid) ? undefined : true), {
      interval: 20,
      clock: globalThis,
      signal: t.signal,
    });
    const ended = performance.now() - killedAt;

    // Assert
    assert.equal(afterTheKill, true);
    assert.ok(ended >= 900, `it ended ${ended} ms after the kill`);
  } finally {
    if (running(pid)) process.kill(pid, 'SIGKILL');
  }
});
