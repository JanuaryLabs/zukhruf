import { randomUUID } from 'node:crypto';

import { untilAborted } from '@zukhruf/async';

import { FencingToken } from '../../fencing/fencing-token.ts';
import type { LockHandle } from '../../mutex/lease.ts';
import { LockLostError } from '../../mutex/lock-lost-error.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import type { ConnectionSupervisor } from './connection-supervisor.ts';
import { CoordinatorUnavailableError } from './coordinator-unavailable-error.ts';
import type { LockRequest, LockResponse } from './protocol.ts';
import { Queries } from './queries.ts';

interface Pending {
  key: string;
  /** A wait is sent again after a reconnect; a try gives up instead. */
  attempt: 'acquire' | 'try';
  /**
   * `queued` waits for a connection, `sent` went out on the open one, and
   * `stranded` went out on a connection that was lost before it was answered.
   */
  delivery: 'queued' | 'sent' | 'stranded';
  answer: PromiseWithResolvers<FencingToken | undefined>;
}

interface Held {
  key: string;
  token: FencingToken;
  /** Aborts the lease's signal once another holder may have been granted the key. */
  lost: AbortController;
}

/**
 * Asks a coordinator for keys over a supervised connection. When the
 * connection is replaced, it reasserts the keys it holds and asks again for the
 * ones it waits for. A held key whose reassertion is refused is lost.
 */
export class RemoteLockClient implements LockStore {
  readonly #link: ConnectionSupervisor<LockRequest, LockResponse>;
  readonly #pending = new Map<string, Pending>();
  readonly #held = new Map<string, Held>();
  readonly #queries: Queries;

  constructor(link: ConnectionSupervisor<LockRequest, LockResponse>) {
    this.#link = link;
    this.#queries = new Queries(link, () => this.#updateRef());
    link.on('connected', () => this.#resume());
    link.on('message', (response) => this.#receive(response));
    link.on('disconnected', () => this.#interrupt());
    // Held keys stay exclusive: no coordinator is left to grant them to anyone else.
    link.on('unavailable', () =>
      this.#rejectAll((key) => new CoordinatorUnavailableError(key)),
    );
    link.on('failed', (error) => this.#fail(error));
  }

  async acquire(
    key: string,
    { signal }: AcquireOptions = {},
  ): Promise<LockHandle> {
    signal?.throwIfAborted();
    const id = randomUUID();
    const { answer } = this.#request(id, key, 'acquire');
    try {
      const token = await untilAborted(answer.promise, signal);
      // The coordinator answers 'busy' only to a try; an acquire waits for its grant.
      if (!token) {
        throw new Error(
          `The lock coordinator answered 'busy' to an acquire of key "${key}".`,
        );
      }
      return this.#hold(id, key, token);
    } catch (error) {
      if (signal?.aborted) this.#withdraw(id);
      throw error;
    }
  }

  async tryAcquire(key: string): Promise<LockHandle | undefined> {
    const id = randomUUID();
    const token = await this.#request(id, key, 'try').answer.promise;
    return token && this.#hold(id, key, token);
  }

  async isHeld(key: string): Promise<boolean> {
    this.#assertUsable(key);
    return this.#queries.ask(key);
  }

  /** Disconnects for good. Over a socket, the coordinator then releases whatever this client still holds. */
  async close() {
    const closing = this.#link.close();
    this.#rejectAll(() => new Error('This lock client is closed.'));
    await closing;
  }

  #assertUsable(key: string) {
    if (this.#link.status === 'closed') {
      throw new Error('This lock client is closed.');
    }
    if (this.#link.status === 'unavailable') {
      throw new CoordinatorUnavailableError(key);
    }
  }

  #request(id: string, key: string, attempt: Pending['attempt']): Pending {
    this.#assertUsable(key);
    const pending: Pending = {
      key,
      attempt,
      delivery: 'queued',
      answer: Promise.withResolvers(),
    };
    this.#pending.set(id, pending);
    this.#updateRef();
    this.#link.open();
    this.#dispatch(id, pending);
    return pending;
  }

  #dispatch(id: string, pending: Pending) {
    const { key, attempt } = pending;
    if (this.#link.send({ op: attempt, id, key })) pending.delivery = 'sent';
  }

  /** The caller gave up. A grant already on its way is given back by the coordinator on `cancel`. */
  #withdraw(id: string) {
    const pending = this.#take(id);
    if (!pending || pending.delivery === 'sent') {
      this.#link.send({ op: 'cancel', id });
    }
  }

  #hold(id: string, key: string, token: FencingToken): LockHandle {
    const lost = new AbortController();
    this.#held.set(id, { key, token, lost });
    return {
      token,
      signal: lost.signal,
      [Symbol.asyncDispose]: async () => {
        // A lost key is no longer this client's to release. Forget the key
        // first, so a reconnect cannot reassert a released lease. Without an
        // open connection there is nothing to tell: the coordinator that
        // granted the key is gone.
        if (this.#held.delete(id)) this.#link.send({ op: 'release', id });
      },
    };
  }

  /** Another holder may be granted `id`'s key now, so its lease is told and nothing reasserts it. */
  #lose(id: string) {
    const held = this.#held.get(id);
    if (!held) return;
    this.#held.delete(id);
    held.lost.abort(new LockLostError(held.key));
  }

  #receive(response: LockResponse) {
    switch (response.op) {
      case 'granted': {
        const pending = this.#take(response.id);
        if (pending) {
          pending.answer.resolve(new FencingToken(BigInt(response.token)));
        } else {
          // Nobody waits for this grant any more (the request was cancelled), so give the key back.
          this.#link.send({ op: 'release', id: response.id });
        }
        return;
      }
      case 'busy':
        this.#take(response.id)?.answer.resolve(undefined);
        return;
      case 'rejected':
        this.#lose(response.id);
        return;
      case 'held':
        this.#queries.answer(response.id, response.held);
        return;
      case 'unsupported':
        this.#queries.refuse(response.id);
        return;
    }
  }

  /** A new connection: reassert held keys first, then send what waits. */
  #resume() {
    // A new connection starts with its adapter's default, which may not match whether this client waits.
    this.#updateRef();
    for (const [id, { key, token }] of this.#held) {
      this.#link.send({ op: 'reassert', id, key, token: token.toString() });
    }
    for (const [id, pending] of this.#pending) {
      // A try is one attempt; the coordinator that would have answered it is gone.
      if (pending.delivery === 'stranded')
        this.#take(id)?.answer.resolve(undefined);
      else if (pending.delivery === 'queued') this.#dispatch(id, pending);
    }
    this.#queries.askAgain();
  }

  #interrupt() {
    for (const pending of this.#pending.values()) {
      if (pending.delivery !== 'sent') continue;
      pending.delivery = pending.attempt === 'try' ? 'stranded' : 'queued';
    }
  }

  /** No coordinator heard the reassertions, so another holder may be granted the held keys. */
  #fail(error: unknown) {
    for (const id of [...this.#held.keys()]) this.#lose(id);
    this.#rejectAll(() => error);
  }

  #rejectAll(reason: (key: string) => unknown) {
    for (const [id, { key }] of this.#pending) {
      this.#take(id)?.answer.reject(reason(key));
    }
    this.#queries.rejectAll(reason);
  }

  /** Removes a request that is about to be answered, so a late grant for it is given back. */
  #take(id: string): Pending | undefined {
    const pending = this.#pending.get(id);
    if (!pending) return undefined;
    this.#pending.delete(id);
    this.#updateRef();
    return pending;
  }

  #updateRef() {
    if (this.#pending.size > 0 || this.#queries.size > 0) this.#link.ref();
    else this.#link.unref();
  }
}
