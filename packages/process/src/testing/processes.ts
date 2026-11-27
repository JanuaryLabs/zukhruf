import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { poll } from '@zukhruf/async';

/** Whether `pid` runs: it exists and is not a zombie that waits for its parent. */
export function running(pid: number): boolean {
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
export function groupExists(pgid: number): boolean {
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
export function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch (error) {
    const code = Reflect.get(Object(error), 'code');
    if (code !== 'ESRCH' && code !== 'EPERM') throw error;
  }
}

export function groupOf(pid: number): number {
  return Number(
    execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim(),
  );
}

/** The pids that a process wrote so far, one on each line. */
export async function pidsOf(file: string): Promise<number[]> {
  const text = await readFile(file, 'utf8').catch((error: unknown) => {
    // The process has not written the file yet.
    if (Reflect.get(Object(error), 'code') === 'ENOENT') return '';
    throw error;
  });
  return text.split('\n').filter(Boolean).map(Number);
}

/** The pid that a process wrote, once it is there. */
export function pidIn(file: string, signal: AbortSignal): Promise<number> {
  return poll(async () => (await pidsOf(file))[0], {
    interval: 20,
    clock: globalThis,
    signal,
  });
}

/** The pid of a process and of its child, once both are there. */
export function pidsIn(
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
