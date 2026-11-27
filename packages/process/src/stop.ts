import { type Clock, poll } from '@zukhruf/async';

/**
 * Stops the process group of a keeper (ADR 0005): SIGTERM to the group, and
 * SIGKILL to the group when it still runs after `grace` on `clock`. Resolves
 * when the keeper has ended and no member of the group is left.
 *
 * After the keeper ends, a member that SIGTERM ended can still be in the group
 * for a moment, until its new parent reaps it, so the group is polled until it
 * is empty. After the SIGKILL nothing in the group can run, so nothing is
 * polled then.
 */
export async function stopGroup(
  pgid: number,
  keeperEnded: Promise<unknown>,
  { grace, clock }: { grace: number; clock: Clock },
): Promise<void> {
  signalGroup(pgid, 'SIGTERM');
  const killed = Promise.withResolvers<void>();
  const timer = clock.setTimeout(() => {
    signalGroup(pgid, 'SIGKILL');
    killed.resolve();
  }, grace);
  const settled = new AbortController();
  try {
    const killedFirst = await Promise.race([
      keeperEnded.then(() => false),
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

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (Reflect.get(Object(error), 'code') !== 'ESRCH') throw error;
  }
}

function groupIsEmpty(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    if (Reflect.get(Object(error), 'code') === 'ESRCH') return true;
    throw error;
  }
}
