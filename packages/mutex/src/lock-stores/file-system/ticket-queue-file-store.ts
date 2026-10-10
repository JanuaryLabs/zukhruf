import { appendFile } from 'node:fs/promises';

import { atomicWrite, draftSuffixLength, patiently } from '@zukhruf/fs';

import { Caller } from './caller.ts';
import { FileLockStore } from './file-lock-store.ts';
import { Presence } from './presence.ts';
import { readRecord } from './record-file.ts';

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
  /** The longer of a presence file and the draft that `atomicWrite` writes beside the record. */
  protected readonly longestSuffix = Math.max(
    Presence.suffixLength,
    draftSuffixLength,
  );

  protected async lock(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<AsyncDisposable> {
    const me = Caller.current();
    await using leaving = new AsyncDisposableStack();
    const presence = Presence.claim(path, me);
    leaving.defer(() => leave(path, me, presence));
    await enqueue(path, me);
    await this.poll(() => this.#attempt(path, me), signal);
    leaving.move();
    return holding(path, me, presence);
  }

  protected async tryLock(path: string): Promise<AsyncDisposable | undefined> {
    const head = await readHead(path);
    if (head) await this.#evictGoneHeads(path, head);
    if ((await readTickets(path)).length > 0) return undefined;

    const me = Caller.current();
    await using leaving = new AsyncDisposableStack();
    const presence = Presence.claim(path, me);
    leaving.defer(() => leave(path, me, presence));
    await enqueue(path, me);
    // Another waiter appended at the same moment and is first.
    if ((await readHead(path))?.id !== me.id) return undefined;
    leaving.move();
    return holding(path, me, presence);
  }

  /** The first ticket's caller holds the key. A gone one does not, and a waiter behind it holds nothing yet. */
  protected isHeldAt(path: string): Promise<boolean> {
    return Presence.isNamedCallerPresent(path, () => readHead(path));
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
  const state = await Presence.judge(path, head, () => readHead(path));
  return state === 'gone';
}

/**
 * A waiter that gives up keeps its ticket in line: only the head may rewrite
 * the queue. Its presence ends, so the ticket reads as gone and whoever finds
 * it first evicts it, together with the presence file.
 */
async function leave(path: string, me: Caller, presence: Presence) {
  using reading = new DisposableStack();
  reading.defer(() => presence.end());
  const tickets = await readTickets(path);
  reading.move();
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

/** The caller of the first ticket, which holds the key while it runs. */
async function readHead(path: string): Promise<Caller | undefined> {
  const [head] = await readTickets(path);
  return head;
}

async function readTickets(path: string): Promise<Caller[]> {
  const content = await readRecord(path);
  if (content === undefined) return [];
  // The last segment is empty or a ticket still being appended.
  return content.split('\n').slice(0, -1).map(Caller.parse);
}

async function replace(path: string, tickets: Caller[]) {
  await atomicWrite(
    path,
    tickets.map((ticket) => `${ticket.serialize()}\n`).join(''),
  );
}
