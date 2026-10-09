import { randomUUID } from 'node:crypto';

import type { ConnectionSupervisor } from './connection-supervisor.ts';
import type { LockRequest, LockResponse } from './protocol.ts';
import { UnsupportedRequestError } from './unsupported-request-error.ts';

/** Keeps only what settles the caller's promise; the caller keeps the promise. */
interface Query extends Pick<
  PromiseWithResolvers<boolean>,
  'resolve' | 'reject'
> {
  key: string;
}

/**
 * The looks at keys that wait for a coordinator's answer. A look holds
 * nothing, so asking it twice does no harm: a look that a lost connection cut
 * off is asked again of the next coordinator.
 */
export class Queries {
  readonly #link: ConnectionSupervisor<LockRequest, LockResponse>;
  /** Called whenever a look starts or ends waiting. */
  readonly #changed: () => void;
  readonly #waiting = new Map<string, Query>();

  constructor(
    link: ConnectionSupervisor<LockRequest, LockResponse>,
    changed: () => void,
  ) {
    this.#link = link;
    this.#changed = changed;
  }

  get size(): number {
    return this.#waiting.size;
  }

  ask(key: string): Promise<boolean> {
    const id = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<boolean>();
    this.#waiting.set(id, { key, resolve, reject });
    this.#changed();
    this.#link.open();
    this.#link.send({ op: 'isHeld', id, key });
    return promise;
  }

  /** A new connection: asks each look that has no answer yet. */
  askAgain() {
    for (const [id, { key }] of this.#waiting) {
      this.#link.send({ op: 'isHeld', id, key });
    }
  }

  answer(id: string, held: boolean) {
    this.#take(id)?.resolve(held);
  }

  /** The coordinator does not know the look: it runs an older version. */
  refuse(id: string) {
    const query = this.#take(id);
    query?.reject(new UnsupportedRequestError('isHeld', query.key));
  }

  rejectAll(reason: (key: string) => unknown) {
    for (const [id, { key }] of this.#waiting) {
      this.#take(id)?.reject(reason(key));
    }
  }

  #take(id: string): Query | undefined {
    const query = this.#waiting.get(id);
    if (!query) return undefined;
    this.#waiting.delete(id);
    this.#changed();
    return query;
  }
}
