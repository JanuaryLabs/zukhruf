import { setImmediate as nextTurn } from 'node:timers/promises';

const pending = Symbol('pending');

/**
 * What the call settled with before the event loop's next turn: its
 * rejection reason, 'answered', or `pending`. A call that rejects at once
 * settles in microtasks; one that waits on a part that never settles stays
 * pending, so the assertion fails there, not at the time limit.
 */
export const settledThisTurn = (call: Promise<unknown>): Promise<unknown> =>
  Promise.race([
    call.then(
      () => 'answered',
      (reason: unknown) => reason,
    ),
    nextTurn(pending),
  ]);
