import { readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';

import { atomicWrite } from '../../shared/fs/atomic-write.ts';
import { isErrno } from '../../shared/fs/errno.ts';
import { patiently } from '../../shared/fs/patiently.ts';
import { Caller } from './caller.ts';
import { FileLockStore } from './file-lock-store.ts';
import { Presence } from './presence.ts';

/**
 * FIFO queue in one file: each waiter appends its ticket line and holds the
 * lock once its ticket is first.
 *
 * Appends are atomic (O_APPEND), and the file is only ever replaced by the
 * live head releasing or by the reclaim-lock holder evicting a gone head, so
 * two rewrites never race. A rewrite racing an append can drop that ticket;
 * its waiter notices and appends it again.
 */
export class TicketQueueFileStore extends FileLockStore {
  /** A presence file has the longest name this store makes for a key. */
  protected readonly longestSuffix = Presence.suffixLength;

  protected async lock(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<AsyncDisposable> {
    const me = Caller.current();
    await using leaving = new AsyncDisposableStack();
    const presence = Presence.claim(Presence.pathOf(path, me));
    leaving.defer(() => leave(path, me, presence));
    await enqueue(path, me);
    await this.poll(() => this.#attempt(path, me), { signal });
    leaving.move();
    return holding(path, me, presence);
  }

  protected async tryLock(path: string): Promise<AsyncDisposable | undefined> {
    const [head] = await readTickets(path);
    if (head) await this.#evictGoneHeads(path, head);
    if ((await readTickets(path)).length > 0) return undefined;

    const me = Caller.current();
    await using leaving = new AsyncDisposableStack();
    const presence = Presence.claim(Presence.pathOf(path, me));
    leaving.defer(() => leave(path, me, presence));
    await enqueue(path, me);
    const [first] = await readTickets(path);
    // Another waiter appended at the same moment and is first.
    if (first?.id !== me.id) return undefined;
    leaving.move();
    return holding(path, me, presence);
  }

  async #attempt(path: string, me: Caller): Promise<true | undefined> {
    const tickets = await readTickets(path);
    if (!tickets.some((ticket) => ticket.id === me.id)) {
      await enqueue(path, me);
      return undefined;
    }

    const [head] = tickets;
    if (head?.id === me.id) return true;
    if (head) await this.#evictGoneHeads(path, head);
    return undefined;
  }

  /**
   * Evicts the run of gone callers at the head of the queue. Each caller is
   * found gone before the queue is read: a gone caller never writes again, so
   * a queue that still starts with it is current, and writing it back cannot
   * drop a later holder's ticket.
   */
  async #evictGoneHeads(path: string, head: Caller) {
    if (!(await isGone(path, head))) return;
    await this.withReclaimLock(path, async () => {
      let gone = head;
      for (;;) {
        const tickets = await readTickets(path);
        if (tickets[0]?.id !== gone.id) return;
        const rest = tickets.filter((ticket) => ticket.id !== gone.id);
        await replace(path, rest);
        await Presence.delete(Presence.pathOf(path, gone));
        const [next] = rest;
        if (!next || !(await isGone(path, next))) return;
        gone = next;
      }
    });
  }
}

/** Whether the caller at the head of the queue at `path` no longer runs. */
async function isGone(path: string, head: Caller): Promise<boolean> {
  const presence = Presence.pathOf(path, head);
  const state = Presence.check(presence);
  if (state === 'missing') {
    // A ticket leaves the queue before its presence file, so a ticket still first never had one.
    if ((await readTickets(path))[0]?.id === head.id) {
      throw Presence.missing(path, presence);
    }
    return false;
  }
  return state === 'gone';
}

/**
 * A waiter that gives up keeps its ticket in line: only the head may rewrite
 * the queue. Its presence ends, so the ticket reads as gone and whoever finds
 * it first evicts it, together with the presence file.
 */
async function leave(path: string, me: Caller, presence: Presence) {
  const tickets = await readTickets(path).catch((error: unknown) => {
    presence.end();
    throw error;
  });
  if (tickets.some((ticket) => ticket.id === me.id)) presence.end();
  else await presence.withdraw();
}

function holding(
  path: string,
  me: Caller,
  presence: Presence,
): AsyncDisposable {
  return {
    [Symbol.asyncDispose]: () =>
      presence.releaseAfter(() => removeTicket(path, me)),
  };
}

async function removeTicket(path: string, me: Caller) {
  const remaining = await readTickets(path);
  await replace(
    path,
    remaining.filter((ticket) => ticket.id !== me.id),
  );
}

async function enqueue(path: string, caller: Caller) {
  await patiently(() => appendFile(path, `${caller.serialize()}\n`));
}

async function readTickets(path: string): Promise<Caller[]> {
  try {
    // Windows cannot replace a file while another handle has it open, so a
    // release rename fails while waiters read the queue. A synchronous read
    // opens and closes the file in one call; the asynchronous read of Node.js
    // 24 keeps it open across several turns of the event loop.
    const content = await patiently(async () => readFileSync(path, 'utf8'));
    // The last segment is empty or a ticket still being appended.
    return content.split('\n').slice(0, -1).map(Caller.parse);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [];
    throw error;
  }
}

async function replace(path: string, tickets: Caller[]) {
  await atomicWrite(
    path,
    tickets.map((ticket) => `${ticket.serialize()}\n`).join(''),
  );
}
