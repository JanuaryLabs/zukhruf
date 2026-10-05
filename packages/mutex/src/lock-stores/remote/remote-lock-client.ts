import { randomUUID } from 'node:crypto';

import { FencingToken } from '../../fencing/fencing-token.ts';
import type { Lease } from '../../mutex/lease.ts';
import { LockLostError } from '../../mutex/lock-lost-error.ts';
import type { AcquireOptions, LockStore } from '../../mutex/lock-store.ts';
import { untilAborted } from '../../shared/until-aborted.ts';
import type { ClientConnection, Connector } from './connector.ts';
import { CoordinatorUnavailableError } from './coordinator-unavailable-error.ts';
import type { LockRequest, LockResponse } from './protocol.ts';

interface Pending {
  key: string;
  /** A wait is sent again after a reconnect; a try gives up instead. */
  attempt: 'acquire' | 'try';
  answer: PromiseWithResolvers<FencingToken | undefined>;
}

interface Held {
  key: string;
  token: FencingToken;
}

/**
 * Asks a coordinator for keys over a connection. When the connection drops, it
 * asks its connector for another, reasserts the keys it holds and re-requests
 * the ones it waits for. A held key whose reassertion is refused is lost.
 */
export class RemoteLockClient implements LockStore {
  readonly #connector: Connector;
  readonly #pending = new Map<string, Pending>();
  readonly #held = new Map<string, Held>();
  readonly #lost = new Set<string>();
  #connection: Promise<ClientConnection | undefined> | undefined;
  #current: ClientConnection | undefined;
  #closed = false;

  constructor(connector: Connector) {
    this.#connector = connector;
  }

  async acquire(key: string, { signal }: AcquireOptions = {}): Promise<Lease> {
    signal?.throwIfAborted();
    const id = randomUUID();
    try {
      const token = await untilAborted(
        this.#request(id, key, 'acquire'),
        signal,
      );
      // The coordinator answers 'busy' only to a try; an acquire waits for its grant.
      if (!token) {
        throw new Error(
          `The lock coordinator answered 'busy' to an acquire of key "${key}".`,
        );
      }
      return this.#hold(id, key, token);
    } catch (error) {
      if (signal?.aborted && this.#current) {
        void this.#send(this.#current, { op: 'cancel', id });
      }
      throw error;
    } finally {
      this.#pending.delete(id);
      this.#updateRef();
    }
  }

  async tryAcquire(key: string): Promise<Lease | undefined> {
    const id = randomUUID();
    try {
      const token = await this.#request(id, key, 'try');
      return token && this.#hold(id, key, token);
    } finally {
      this.#pending.delete(id);
      this.#updateRef();
    }
  }

  async #request(
    id: string,
    key: string,
    attempt: Pending['attempt'],
  ): Promise<FencingToken | undefined> {
    if (this.#closed) throw new Error('This lock client is closed.');
    const answer = Promise.withResolvers<FencingToken | undefined>();
    this.#pending.set(id, { key, attempt, answer });
    this.#updateRef();
    this.#connection ??= this.#open();
    const connection = await this.#connection;
    if (!connection) throw new CoordinatorUnavailableError(key);
    void this.#send(connection, { op: attempt, id, key });
    return answer.promise;
  }

  #hold(id: string, key: string, token: FencingToken): Lease {
    this.#held.set(id, { key, token });
    return {
      token,
      [Symbol.asyncDispose]: async () => {
        // Forget the key first, so a reconnect cannot reassert a released lease.
        const wasHeld = this.#held.delete(id);
        if (this.#lost.delete(id)) throw new LockLostError(key);
        if (wasHeld && this.#current) {
          await this.#send(this.#current, { op: 'release', id });
        }
      },
    };
  }

  async #open(): Promise<ClientConnection | undefined> {
    const connection = await this.#connector.connect();
    if (!connection) {
      this.#connection = undefined;
      return undefined;
    }
    this.#current = connection;
    connection.listen({
      message: (response) => this.#receive(connection, response),
      close: () => this.#reconnect(connection),
    });
    this.#updateRef();
    return connection;
  }

  #receive(connection: ClientConnection, response: LockResponse) {
    const pending = this.#pending.get(response.id);
    switch (response.op) {
      case 'granted':
        if (pending) {
          pending.answer.resolve(new FencingToken(BigInt(response.token)));
        } else {
          // Nobody waits for this grant any more (the request was cancelled), so give the key back.
          void this.#send(connection, { op: 'release', id: response.id });
        }
        return;
      case 'busy':
        pending?.answer.resolve(undefined);
        return;
      case 'rejected':
        if (this.#held.delete(response.id)) this.#lost.add(response.id);
        return;
    }
  }

  async #send(connection: ClientConnection, request: LockRequest) {
    try {
      await connection.send(request);
    } catch {
      this.#reconnect(connection);
    }
  }

  /** Disconnects for good; the coordinator releases whatever this client still holds. */
  close() {
    this.#closed = true;
    const current = this.#current;
    this.#current = undefined;
    current?.close();
  }

  #reconnect(lost: ClientConnection) {
    if (this.#closed || this.#current !== lost) return;
    this.#current = undefined;
    lost.close();
    this.#connection = this.#open();
    void this.#connection.then((connection) => this.#resume(connection));
  }

  async #resume(connection: ClientConnection | undefined) {
    if (!connection) {
      // Held keys stay exclusive: no coordinator is left to grant them to anyone else.
      for (const { key, answer } of this.#pending.values()) {
        answer.reject(new CoordinatorUnavailableError(key));
      }
      return;
    }
    for (const [id, { key, token }] of this.#held) {
      await this.#send(connection, {
        op: 'reassert',
        id,
        key,
        token: token.toString(),
      });
    }
    for (const [id, { key, attempt, answer }] of this.#pending) {
      // A try is one attempt; the coordinator that would have answered it is gone.
      if (attempt === 'try') answer.resolve(undefined);
      else await this.#send(connection, { op: 'acquire', id, key });
    }
  }

  #updateRef() {
    if (this.#pending.size > 0) this.#current?.ref();
    else this.#current?.unref();
  }
}
