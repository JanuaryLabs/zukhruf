import { MemoryStore } from '../lock-stores/memory/memory-store.ts';
import type { LockHandle } from '../mutex/lease.ts';
import type { AcquireOptions } from '../mutex/lock-store.ts';

/**
 * The line of the callers of each key in this process. A lock store puts each
 * call in the line first, so only the first caller of a key takes the
 * store's resource of the key (a file, a session or a claim): one resource
 * per key per process, however many callers wait, and first-come order within
 * the process.
 */
export class InProcessTurns {
  readonly #lines = new MemoryStore();

  /** Waits for the turn of `key`, then calls `take`. A cancel of `options.signal` also ends the wait for the turn. */
  async acquire(
    key: string,
    options: AcquireOptions | undefined,
    take: () => Promise<LockHandle>,
  ): Promise<LockHandle> {
    await using turn = new AsyncDisposableStack();
    // Joining the line is synchronous, so the order is the order of the calls.
    turn.use(await this.#lines.acquire(key, options));
    return withTurn(await take(), turn);
  }

  /** Calls `take` only when no caller in this process has the turn of `key`. */
  async tryAcquire(
    key: string,
    take: () => Promise<LockHandle | undefined>,
  ): Promise<LockHandle | undefined> {
    await using turn = new AsyncDisposableStack();
    const inProcess = await this.#lines.tryAcquire(key);
    if (!inProcess) return undefined;
    turn.use(inProcess);
    const handle = await take();
    return handle && withTurn(handle, turn);
  }
}

/** Releases the key in the store first, then lets the next caller in this process continue. */
function withTurn(handle: LockHandle, turn: AsyncDisposableStack): LockHandle {
  turn.use(handle);
  const release = turn.move();
  return {
    token: handle.token,
    signal: handle.signal,
    [Symbol.asyncDispose]: () => release.disposeAsync(),
  };
}
