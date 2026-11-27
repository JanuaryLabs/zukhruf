import { randomUUID } from 'node:crypto';

import { untilAborted } from '@zukhruf/async';
import { FencingToken } from '@zukhruf/fencing';
import { LeaseController } from '@zukhruf/lease';
import {
  type ConnectionSupervisor,
  type LostCallPolicy,
  PendingCalls,
} from '@zukhruf/rpc';

import type { LockHandle } from '../../mutex/lease.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { CoordinatorUnavailableError } from './coordinator-unavailable-error.ts';
import { GrantFailedError } from './grant-failed-error.ts';
import {
  type LockRequest,
  type LockResponse,
  isLockResponse,
} from './protocol.ts';

type Grant = FencingToken | undefined;

/** An acquire or a try: a request that waits for a grant. */
type KeyRequest = Extract<LockRequest, { op: 'acquire' | 'try' }>;

type LookRequest = Extract<LockRequest, { op: 'isHeld' }>;

/**
 * A try is one attempt, and the coordinator that would have answered it is
 * gone: it is answered busy once the next coordinator is there, and rejects as
 * each waiting request does when no coordinator comes.
 */
const tryIsBusy: LostCallPolicy<Grant> = {
  atReconnect: (call) => call.resolve(undefined),
};

interface Held {
  key: string;
  token: FencingToken;
  lease: LeaseController;
}

/**
 * Asks a coordinator for keys over a supervised connection. When the
 * connection is replaced, it reasserts the keys it holds and asks again for the
 * ones it waits for. A held key whose reassertion is refused is lost.
 */
export class RemoteLockClient implements LockStore {
  readonly #link: ConnectionSupervisor<LockRequest>;
  /** The acquires and tries that wait for their answer. An acquire that a lost connection cut off is sent again. */
  readonly #requests: PendingCalls<KeyRequest, Grant>;
  /** The looks at keys. A look holds nothing, so asking it twice does no harm: one that a lost connection cut off is asked again. */
  readonly #looks: PendingCalls<LookRequest, boolean>;
  readonly #held = new Map<string, Held>();

  constructor(link: ConnectionSupervisor<LockRequest>) {
    this.#link = link;
    // Both tables hold the link's one count: the connection stays ref'd while a request or a look waits.
    this.#requests = new PendingCalls<KeyRequest, Grant>(link);
    this.#looks = new PendingCalls<LookRequest, boolean>(link);
    link.on('connected', () => this.#resume());
    // A message this client cannot read answers nothing it waits for.
    link.on('message', (message) => {
      if (isLockResponse(message)) this.#receive(message);
    });
    link.on('disconnected', () => {
      this.#requests.interrupt();
      this.#looks.interrupt();
    });
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
    this.#assertUsable(key);
    const id = randomUUID();
    const answer = this.#requests.add(id, { op: 'acquire', id, key }, 'resend');
    try {
      const token = await untilAborted(answer, signal);
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
    this.#assertUsable(key);
    const id = randomUUID();
    const token = await this.#requests.add(
      id,
      { op: 'try', id, key },
      tryIsBusy,
    );
    return token && this.#hold(id, key, token);
  }

  async isHeld(key: string): Promise<boolean> {
    this.#assertUsable(key);
    const id = randomUUID();
    return this.#looks.add(id, { op: 'isHeld', id, key }, 'resend');
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

  /** The caller gave up. A grant already on its way is given back by the coordinator on `cancel`. */
  #withdraw(id: string) {
    const request = this.#requests.take(id);
    if (!request || request.sent) {
      this.#link.send({ op: 'cancel', id });
    }
  }

  #hold(id: string, key: string, token: FencingToken): LockHandle {
    const lease = new LeaseController(key);
    this.#held.set(id, { key, token, lease });
    return {
      token,
      signal: lease.signal,
      [Symbol.asyncDispose]: async () => {
        lease.end();
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
    held.lease.lose();
  }

  #receive(response: LockResponse) {
    switch (response.op) {
      case 'granted': {
        const request = this.#requests.take(response.id);
        if (request) {
          // isLockResponse admits only a token that parses.
          request.resolve(FencingToken.parse(response.token)!);
        } else {
          // Nobody waits for this grant any more (the request was cancelled), so give the key back.
          this.#link.send({ op: 'release', id: response.id });
        }
        return;
      }
      case 'busy':
        this.#requests.take(response.id)?.resolve(undefined);
        return;
      case 'failed': {
        const request = this.#requests.take(response.id);
        request?.reject(
          new GrantFailedError(request.request.key, response.message),
        );
        return;
      }
      case 'rejected':
        this.#lose(response.id);
        return;
      case 'held':
        this.#looks.take(response.id)?.resolve(response.held);
        return;
    }
  }

  /**
   * A new connection: reassert held keys first, then the end-of-reasserts
   * marker, then send what waits. A connection keeps the order of its
   * messages, so a new leader that reads the marker has read every reassert
   * of this client (ADR 0033).
   */
  #resume() {
    for (const [id, { key, token }] of this.#held) {
      this.#link.send({ op: 'reassert', id, key, token: token.toString() });
    }
    this.#link.send({ op: 'reasserted' });
    this.#requests.resume();
    this.#looks.resume();
  }

  /** No coordinator heard the reassertions, so another holder may be granted the held keys. */
  #fail(error: unknown) {
    for (const id of [...this.#held.keys()]) this.#lose(id);
    this.#rejectAll(() => error);
  }

  #rejectAll(reason: (key: string) => unknown) {
    this.#requests.rejectAll(({ key }) => reason(key));
    this.#looks.rejectAll(({ key }) => reason(key));
  }
}
