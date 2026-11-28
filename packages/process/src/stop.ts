import { type Clock, poll } from '@zukhruf/async';

import { errorCode } from './error-code.ts';

/**
 * Stops the process group of a program under the keeper (ADR 0005): SIGTERM
 * and then SIGCONT to the group, and SIGKILL to the group when it still runs
 * after `grace` on `clock`. Resolves when the program has ended and no member
 * of the group is left.
 *
 * After the program ends, a member that SIGTERM ended, or the watcher of the
 * keeper, can still be in the group for a moment, until it exits and its new
 * parent reaps it, so the group is polled until it is empty. After the SIGKILL
 * nothing in the group can run, so nothing is polled then.
 */
export async function stopGroup(
  pgid: number,
  programEnded: Promise<unknown>,
  { grace, clock }: { grace: number; clock: Clock },
): Promise<void> {
  signalGroup(pgid, 'SIGTERM');
  // A frozen member gets the SIGTERM only when it runs again, so it would wait
  // out the grace; systemd's kill_and_sigcont sends SIGCONT for the same reason.
  signalGroup(pgid, 'SIGCONT');
  const killed = Promise.withResolvers<void>();
  const timer = clock.setTimeout(() => {
    signalGroup(pgid, 'SIGKILL');
    killed.resolve();
  }, grace);
  const settled = new AbortController();
  try {
    const killedFirst = await Promise.race([
      programEnded.then(() => false),
      killed.promise.then(() => true),
    ]);
    if (killedFirst) return;
    const emptied = poll(async () => (groupIsEmpty(pgid) ? true : undefined), {
      interval: 10,
      clock,
      signal: settled.signal,
    }).catch((error: unknown) => {
      if (!settled.signal.aborted) throw error;
    });
    await Promise.race([killed.promise, emptied]);
  } finally {
    settled.abort();
    clock.clearTimeout(timer);
  }
}

/**
 * macOS answers EPERM, not ESRCH, for a group whose members are all zombies
 * that wait for their parent to reap them: the program between the end of its
 * stdout and its reaping (probed 2026-11-27). Nothing in such a group runs, so
 * neither answer leaves anything to signal, and the signal gives false.
 */
export function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'ESRCH' && code !== 'EPERM') throw error;
    return false;
  }
}

function groupIsEmpty(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    const code = errorCode(error);
    // EPERM: only zombies are left, not reaped yet (see signalGroup).
    if (code === 'EPERM') return false;
    if (code === 'ESRCH') return true;
    throw error;
  }
}
