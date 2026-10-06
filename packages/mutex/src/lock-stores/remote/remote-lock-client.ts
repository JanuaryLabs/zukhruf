import { randomUUID } from 'node:crypto';

import { FencingToken } from '../../fencing/fencing-token.ts';
import type { Lease } from '../../mutex/lease.ts';
import { LockLostError } from '../../mutex/lock-lost-error.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { untilAborted } from '../../shared/until-aborted.ts';
import type { ConnectionSupervisor } from './connection-supervisor.ts';
import { CoordinatorUnavailableError } from './coordinator-unavailable-error.ts';
import type { LockRequest, LockResponse } from './protocol.ts';

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
  readonly #lost = new Set<string>();

  constructor(link: ConnectionSupervisor<LockRequest, LockResponse>) {
    this.#link = link;
    link.listen({
      connected: () => this.#resume(),
      message: (response) => this.#receive(response),
      disconnected: () => this.#interrupt(),
      // Held keys stay exclusive: no coordinator is left to grant them to anyone else.
      unavailable: () =>
        this.#rejectAll((key) => new CoordinatorUnavailableError(key)),
      failed: (error) => this.#fail(error),
    });
  }

  async acquire(key: string, { signal }: AcquireOptions = {}): Promise<Lease> {
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

  async tryAcquire(key: string): Promise<Lease | undefined> {
    const id = randomUUID();
    const token = await this.#request(id, key, 'try').answer.promise;
    return token && this.#hold(id, key, token);
  }

  /** Disconnects for good. Over a socket, the coordinator then releases whatever this client still holds. */
  async close() {
    const closing = this.#link.close();
    this.#rejectAll(() => new Error('This lock client is closed.'));
    await closing;
  }

  #request(id: string, key: string, attempt: Pending['attempt']): Pending {
    if (this.#link.status === 'closed') {
      throw new Error('This lock client is closed.');
    }
    if (this.#link.status === 'unavailable') {
      throw new CoordinatorUnavailableError(key);
    }
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

  #hold(id: string, key: string, token: FencingToken): Lease {
    this.#held.set(id, { key, token });
    return {
      token,
      [Symbol.asyncDispose]: async () => {
        // Forget the key first, so a reconnect cannot reassert a released lease.
        const wasHeld = this.#held.delete(id);
        if (this.#lost.delete(id)) throw new LockLostError(key);
        // Without an open connection there is nothing to tell: the coordinator that granted the key is gone.
        if (wasHeld) this.#link.send({ op: 'release', id });
      },
    };
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
        if (this.#held.delete(response.id)) this.#lost.add(response.id);
        return;
    }
  }

  /** A new connection: reassert held keys first, then send what waits. */
  #resume() {
    for (const [id, { key, token }] of this.#held) {
      this.#link.send({ op: 'reassert', id, key, token: token.toString() });
    }
    for (const [id, pending] of this.#pending) {
      // A try is one attempt; the coordinator that would have answered it is gone.
      if (pending.delivery === 'stranded')
        this.#take(id)?.answer.resolve(undefined);
      else if (pending.delivery === 'queued') this.#dispatch(id, pending);
    }
  }

  #interrupt() {
    for (const pending of this.#pending.values()) {
      if (pending.delivery !== 'sent') continue;
      pending.delivery = pending.attempt === 'try' ? 'stranded' : 'queued';
    }
  }

  /** No coordinator heard the reassertions, so another holder may be granted the held keys. */
  #fail(error: unknown) {
    for (const id of this.#held.keys()) this.#lost.add(id);
    this.#held.clear();
    this.#rejectAll(() => error);
  }

  #rejectAll(reason: (key: string) => unknown) {
    for (const [id, { key }] of this.#pending) {
      this.#take(id)?.answer.reject(reason(key));
    }
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
    if (this.#pending.size > 0) this.#link.ref();
    else this.#link.unref();
  }
}
