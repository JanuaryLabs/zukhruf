import { randomUUID } from 'node:crypto';

import type { RefCount } from '@zukhruf/async';

import type { ConnectionSupervisor } from './connection-supervisor.ts';
import type { LockRequest } from './protocol.ts';

/** Keeps only what settles the caller's promise; the caller keeps the promise. */
interface Query extends Pick<
  PromiseWithResolvers<boolean>,
  'resolve' | 'reject'
> {
  key: string;
  /** Keeps the process alive while the look waits for its answer. */
  held: Disposable;
}

/**
 * The looks at keys that wait for a coordinator's answer. A look holds
 * nothing, so asking it twice does no harm: a look that a lost connection cut
 * off is asked again of the next coordinator.
 */
export class Queries {
  readonly #link: ConnectionSupervisor<LockRequest>;
  /** Keeps the connection ref'd while a look waits. */
  readonly #refs: RefCount;
  readonly #waiting = new Map<string, Query>();

  constructor(link: ConnectionSupervisor<LockRequest>, refs: RefCount) {
    this.#link = link;
    this.#refs = refs;
  }

  ask(key: string): Promise<boolean> {
    const id = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<boolean>();
    this.#waiting.set(id, { key, resolve, reject, held: this.#refs.hold() });
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

  rejectAll(reason: (key: string) => unknown) {
    for (const [id, { key }] of this.#waiting) {
      this.#take(id)?.reject(reason(key));
    }
  }

  #take(id: string): Query | undefined {
    const query = this.#waiting.get(id);
    if (!query) return undefined;
    this.#waiting.delete(id);
    query.held[Symbol.dispose]();
    return query;
  }
}
